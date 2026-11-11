//! 图床上传（PicGo 兼容子集）：smms / github / aliyun / imgur。
//!
//! 迁移背景：Electron 版直接依赖 npm 的 `picgo` 包（纯 Node，无法在 Tauri 侧复用），
//! 迁移时被整体降级为 no-op（capabilities.picgo=false，UI 置灰）。这里用 Rust
//! 重写四条通道，配置沿用 Electron 的 `userData/picgo-config.json` 结构
//! （`{ picBed: { current, [uploader]: {...} } }`），老用户配置可直接复用。
//!
//! 与 Electron 版的行为差异（有意）：
//! - 上传失败不再静默返回 null 无痕，而是把 HTTP 状态与响应体前 200 字写进日志
//!   （source=picgo），便于用户自查是密钥过期还是仓库权限问题；
//! - 其余三家的签名算法（腾讯云/七牛/又拍云）留待后续版本，未实现的图床在
//!   前端下拉中禁用，避免「配置成功但上传必失败」的误导。
//!
//! @author chiangyang

use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;

use crate::logger::{LogMeta, Logger};

/// 图床上传允许的图片扩展名（与 Electron 版白名单一致，白名单外回落 .png）
const ALLOWED_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

/// 本进程内自增，配合时间戳与纳秒保证同一毫秒多图上传不撞名
static FILE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 图床配置状态：只持有配置文件路径，读写按需进行（与 ai::AiState 同构）
pub(crate) struct PicGoState {
    config_path: PathBuf,
}

impl PicGoState {
    pub fn new(config_path: PathBuf) -> Self {
        Self { config_path }
    }
}

/// 对应 native.ts getPicGoConfig：返回 picBed 段（前端只认 current + 各图床字段）
#[tauri::command]
pub(crate) fn tmd_picgo_get_config(state: tauri::State<'_, PicGoState>) -> Value {
    read_picbed(&state.config_path)
}

/// 对应 native.ts savePicGoConfig：整段替换 picBed，保留配置文件里的其他键
#[tauri::command]
pub(crate) fn tmd_picgo_save_config(state: tauri::State<'_, PicGoState>, config: Value) -> bool {
    if !config.is_object() {
        return false;
    }
    save_picbed(&state.config_path, &config)
}

/// 对应 native.ts uploadImage：上传 base64 图片，返回可访问 URL；失败返回 null
/// （前端契约只有 string|null，失败原因进日志而非返回值）。
#[tauri::command]
pub(crate) async fn tmd_picgo_upload(
    app: tauri::AppHandle,
    base64: String,
    ext: String,
) -> Option<String> {
    // async 命令的 Future 必须 'static：State 的借用不能跨 await，
    // 这里在 await 之前把配置路径 clone 出来，仅捕获 owned 值
    let config_path = app.state::<PicGoState>().config_path.clone();
    if base64.is_empty() {
        return None;
    }
    let safe_ext = normalize_ext(&ext);
    let bytes = match base64::engine::general_purpose::STANDARD.decode(base64.as_bytes()) {
        Ok(b) if !b.is_empty() => b,
        Ok(_) => return None,
        Err(err) => {
            report(&app, &format!("上传失败：base64 解码错误 {}", err));
            return None;
        }
    };
    let picbed = read_picbed(&config_path);
    match upload(&picbed, &bytes, safe_ext).await {
        Ok(url) => Some(url),
        Err(err) => {
            report(&app, &format!("上传失败：{}", err));
            None
        }
    }
}

/// 写一条 error 日志（source=picgo）。Logger 由 setup 阶段 manage(Arc<Logger>)，
/// 缺失时静默忽略——日志不可用不应反过来影响上传结果。
fn report(app: &tauri::AppHandle, message: &str) {
    if let Some(logger) = app.try_state::<Arc<Logger>>() {
        logger.log("error", "picgo", message, None, &LogMeta::default());
    } else {
        eprintln!("[tmd] {}", message);
    }
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

/// 读 picBed 段。文件缺失/损坏/格式不符一律回落 `{ current: "" }`，
/// 让前端走「未配置」分支而不是抛错。
fn read_picbed(path: &Path) -> Value {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return json!({ "current": "" }),
    };
    let root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return json!({ "current": "" }),
    };
    match root.get("picBed") {
        Some(picbed) if picbed.is_object() => picbed.clone(),
        _ => json!({ "current": "" }),
    }
}

/// 整段替换 picBed 并落盘；保留文件里的其他顶层键（PicGo 自身可能写入 uploader 等）
fn save_picbed(path: &Path, picbed: &Value) -> bool {
    let mut root = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    root["picBed"] = picbed.clone();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&root) {
        Ok(text) => std::fs::write(path, text).is_ok(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// 上传分发
// ---------------------------------------------------------------------------

/// 按 picBed.current 分发到具体图床实现
async fn upload(picbed: &Value, bytes: &[u8], ext: &str) -> Result<String, String> {
    let current = picbed
        .get("current")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if current.is_empty() {
        return Err("未配置图床（picBed.current 为空）".into());
    }
    let cfg = picbed.get(&current).cloned().unwrap_or_else(|| json!({}));
    let filename = unique_name(ext);
    match current.as_str() {
        "smms" => upload_smms(&cfg, bytes, ext).await,
        "github" => upload_github(&cfg, bytes, ext, &filename).await,
        "aliyun" => upload_aliyun(&cfg, bytes, ext, &filename).await,
        "imgur" => upload_imgur(&cfg, bytes, ext).await,
        other => Err(format!("图床 {} 暂未支持", other)),
    }
}

/// SM.MS：multipart 上传，Token 直接放 Authorization 头
///
/// multipart 体手工拼接：reqwest 的 multipart feature 会引入额外 crate，
/// 本机/CI 网络受限时离线构建会失败。此处只有单个文件字段，格式固定可控。
async fn upload_smms(cfg: &Value, bytes: &[u8], ext: &str) -> Result<String, String> {
    let token = need(cfg, "token")?;
    let boundary = format!("----tmd{}", unique_name(""));
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(
        format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"smfile\"; filename=\"tmd{e}\"\r\nContent-Type: {m}\r\n\r\n",
            b = boundary,
            e = ext,
            m = mime_of(ext)
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    let resp = reqwest::Client::new()
        .post("https://sm.ms/api/v2/upload")
        .header("Authorization", token)
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("smms 请求失败：{}", e))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("smms 响应解析失败：{}", e))?;
    if let Some(url) = body
        .get("data")
        .and_then(|d| d.get("url"))
        .and_then(Value::as_str)
    {
        return Ok(url.to_string());
    }
    // 同一文件重复上传时 sm.ms 返回 code=image_repeated + images（字符串）
    if let Some(url) = body.get("images").and_then(Value::as_str) {
        if !url.is_empty() {
            return Ok(url.to_string());
        }
    }
    Err(format!("smms 上传被拒：{}", brief(&body)))
}

/// GitHub Contents API：PUT 提交 base64 内容，优先用 customUrl 拼访问地址
async fn upload_github(
    cfg: &Value,
    bytes: &[u8],
    ext: &str,
    filename: &str,
) -> Result<String, String> {
    let repo = need(cfg, "repo")?;
    let token = need(cfg, "token")?;
    let branch = field(cfg, "branch");
    let branch = if branch.is_empty() { "main" } else { branch };
    let key = object_key(field(cfg, "path"), filename);
    let url = format!(
        "https://api.github.com/repos/{}/contents/{}",
        repo.trim_matches('/'),
        key
    );
    let body = json!({
        "message": format!("Upload {}", filename),
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
        "branch": branch,
    });
    let resp = reqwest::Client::new()
        .put(&url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "tmd")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("github 请求失败：{}", e))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("github 响应解析失败：{}", e))?;
    if let Some(download) = body
        .get("content")
        .and_then(|c| c.get("download_url"))
        .and_then(Value::as_str)
    {
        let custom = field(cfg, "customUrl").trim_end_matches('/');
        if custom.is_empty() {
            return Ok(download.to_string());
        }
        return Ok(format!("{}/{}", custom, key));
    }
    Err(format!("github 上传被拒：{}", brief(&body)))
}

/// 阿里云 OSS：PUT Object + OSS V1 签名（HMAC-SHA1）
async fn upload_aliyun(
    cfg: &Value,
    bytes: &[u8],
    ext: &str,
    filename: &str,
) -> Result<String, String> {
    let access_key_id = need(cfg, "accessKeyId")?;
    let access_key_secret = need(cfg, "accessKeySecret")?;
    let bucket = need(cfg, "bucket")?;
    let area = need(cfg, "area")?;
    let key = object_key(field(cfg, "path"), filename);
    let content_type = mime_of(ext);
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let signature = oss_signature(access_key_secret, content_type, &date, bucket, &key);
    let url = format!("https://{}.{}.aliyuncs.com/{}", bucket, area, key);
    let resp = reqwest::Client::new()
        .put(&url)
        .header("Date", date)
        .header("Content-Type", content_type)
        .header(
            "Authorization",
            format!("OSS {}:{}", access_key_id, signature),
        )
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| format!("aliyun 请求失败：{}", e))?;
    if !resp.status().is_success() {
        return Err(format!("aliyun 上传被拒：HTTP {}", resp.status().as_u16()));
    }
    Ok(url)
}

/// 阿里云 OSS V1 签名：base64(HMAC-SHA1(secret, "PUT\n\n{type}\n{date}\n/{bucket}/{key}"))
///
/// 独立成函数便于单测覆盖 stringToSign 的拼接格式（换行位置错一位就会 403，
/// 而真实网络验证需要用户凭据）。
fn oss_signature(secret: &str, content_type: &str, date: &str, bucket: &str, key: &str) -> String {
    let string_to_sign = format!("PUT\n\n{}\n{}\n/{}/{}", content_type, date, bucket, key);
    base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(secret.as_bytes(), string_to_sign.as_bytes()))
}

/// 手写 HMAC-SHA1（RFC 2104）：省掉 hmac crate，保证网络受限时仍可离线构建。
/// 正确性由 RFC 2202 标准向量与 Python hashlib 交叉算出的期望值双重锁定。
fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    use sha1::{Digest, Sha1};
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut hasher = Sha1::new();
        hasher.update(key);
        block[..20].copy_from_slice(&hasher.finalize());
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; BLOCK];
    let mut outer_pad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        inner_pad[i] ^= block[i];
        outer_pad[i] ^= block[i];
    }
    let mut inner = Sha1::new();
    inner.update(inner_pad);
    inner.update(msg);
    let inner_hash = inner.finalize();
    let mut outer = Sha1::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let mut out = [0u8; 20];
    out.copy_from_slice(&outer.finalize());
    out
}

/// Imgur：form 上传 base64，Client-ID 鉴权
async fn upload_imgur(cfg: &Value, bytes: &[u8], ext: &str) -> Result<String, String> {
    let client_id = need(cfg, "clientId")?;
    let form = [
        (
            "image",
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ),
        ("type", "base64".to_string()),
        ("name", format!("tmd{}", ext)),
    ];
    let resp = reqwest::Client::new()
        .post("https://api.imgur.com/3/image")
        .header("Authorization", format!("Client-ID {}", client_id))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("imgur 请求失败：{}", e))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("imgur 响应解析失败：{}", e))?;
    if let Some(link) = body
        .get("data")
        .and_then(|d| d.get("link"))
        .and_then(Value::as_str)
    {
        return Ok(link.to_string());
    }
    Err(format!("imgur 上传被拒：{}", brief(&body)))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/// 扩展名归一：白名单外（含大小写、空值）一律 .png，与 Electron 版一致
fn normalize_ext(ext: &str) -> &'static str {
    let lower = ext.to_ascii_lowercase();
    for allowed in ALLOWED_EXT {
        if lower == *allowed {
            return allowed;
        }
    }
    ".png"
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        _ => "image/png",
    }
}

/// 对象键：把配置里的 path 与随机文件名拼起来，去掉多余的斜杠
fn object_key(path: &str, filename: &str) -> String {
    let prefix = path.trim().trim_matches('/');
    if prefix.is_empty() {
        filename.to_string()
    } else {
        format!("{}/{}", prefix, filename)
    }
}

/// 唯一文件名：毫秒时间戳 + 纳秒尾数 + 进程内序号（多标签同时粘贴不撞名）
fn unique_name(ext: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seq = FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{:03}-{}{}",
        now.as_millis(),
        now.subsec_nanos() / 1_000_000,
        seq,
        ext
    )
}

/// 取必填字符串字段；缺失或空串都视为未配置
fn need<'a>(cfg: &'a Value, key: &str) -> Result<&'a str, String> {
    match cfg.get(key).and_then(Value::as_str) {
        Some(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("图床配置缺少 {}", key)),
    }
}

fn field<'a>(cfg: &'a Value, key: &str) -> &'a str {
    cfg.get(key).and_then(Value::as_str).unwrap_or("")
}

/// 响应体截断：避免把整段 HTML 错误页写进日志
fn brief(body: &Value) -> String {
    let text = body.to_string();
    text.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_falls_back_to_png() {
        assert_eq!(normalize_ext(".PNG"), ".png");
        assert_eq!(normalize_ext(".exe"), ".png");
        assert_eq!(normalize_ext(""), ".png");
        assert_eq!(normalize_ext(".WEBP"), ".webp");
    }

    #[test]
    fn object_key_joins_cleanly() {
        assert_eq!(object_key("img/", "a.png"), "img/a.png");
        assert_eq!(object_key("/img", "a.png"), "img/a.png");
        assert_eq!(object_key("", "a.png"), "a.png");
        assert_eq!(object_key("  ", "a.png"), "a.png");
    }

    #[test]
    fn hmac_sha1_matches_rfc2202() {
        // RFC 2202 test case 1：key=0x0b*20, data="Hi There"
        let out = hmac_sha1(&[0x0b; 20], b"Hi There");
        let hex: String = out.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(hex, "b617318655057264e28bc0b6fb378c8ef146be00");
    }

    #[test]
    fn oss_signature_matches_external_reference() {
        // 期望值由 Python hashlib 对同一 stringToSign 独立算出，
        // 用于锁定换行位置与字段顺序（错一位线上就是 403）。
        let sig = oss_signature(
            "secret",
            "image/png",
            "Wed, 12 Nov 2025 08:00:00 GMT",
            "bucket",
            "img/a.png",
        );
        assert_eq!(sig, "RZvEKvKfFL/03OxuWNM7lxX6+RM=");
    }

    #[test]
    fn config_roundtrip_keeps_other_keys() {
        let path = std::env::temp_dir().join(format!(
            "tmd-picgo-test-{}-{}.json",
            std::process::id(),
            FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, r#"{"picBed":{"current":"smms"},"other":1}"#).unwrap();
        assert!(save_picbed(
            &path,
            &json!({"current":"github","github":{"repo":"a/b"}})
        ));
        let picbed = read_picbed(&path);
        assert_eq!(picbed["current"], "github");
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["other"], 1, "picBed 之外的键必须保留");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_config_reads_empty_current() {
        let path = std::env::temp_dir().join("tmd-picgo-missing-never-exists.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_picbed(&path)["current"], "");
    }
}
