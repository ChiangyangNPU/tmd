//! 图床上传（PicGo 兼容）：smms / github / aliyun / tcyun / qiniu / upyun / imgur。
//!
//! 目录职责：本文件只保留命令入口与上传分发、通用小工具；配置读写见 `config`，
//! 签名与编码原语见 `sign`，multipart 组装见 `http`，各图床实现见 `providers`。
//!
//! 迁移背景：Electron 版直接依赖 npm 的 `picgo` 包（纯 Node，无法在 Tauri 侧复用），
//! 迁移时被整体降级为 no-op（capabilities.picgo=false，UI 置灰）。这里用 Rust
//! 重写七条通道，配置沿用 Electron 的 `userData/picgo-config.json` 结构
//! （`{ picBed: { current, [uploader]: {...} } }`），老用户配置可直接复用。
//!
//! 与 Electron 版的行为差异（有意）：
//! - 上传失败不再静默返回 null 无痕，而是把 HTTP 状态与响应体前 200 字写进日志
//!   （source=picgo），便于用户自查是密钥过期还是仓库权限问题；
//! - 签名类图床（阿里云 OSS / 腾讯云 COS / 七牛）的签名算法各有两三级 HMAC，
//!   均拆成独立函数并用 Python hashlib 独立算出的期望值锁进单测，避免换行或
//!   字段顺序错一位只在线上表现为 403。
//!
//! @author chiangyang

use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;

use crate::logger::{LogMeta, Logger};

mod config;
mod http;
pub(crate) mod providers;
mod sign;

use config::{read_picbed, save_picbed};
use providers::{
    upload_aliyun, upload_github, upload_imgur, upload_qiniu, upload_smms, upload_tcyun,
    upload_upyun,
};

/// 图床上传允许的图片扩展名（与 Electron 版白名单一致，白名单外回落 .png）
const ALLOWED_EXT: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

/// 本进程内自增，配合时间戳与纳秒保证同一毫秒多图上传不撞名
pub(crate) static FILE_SEQ: AtomicU64 = AtomicU64::new(0);

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
        "github" => upload_github(&cfg, bytes, &filename).await,
        "aliyun" => upload_aliyun(&cfg, bytes, ext, &filename).await,
        "tcyun" => upload_tcyun(&cfg, bytes, ext, &filename).await,
        "qiniu" => upload_qiniu(&cfg, bytes, ext, &filename).await,
        "upyun" => upload_upyun(&cfg, bytes, ext, &filename).await,
        "imgur" => upload_imgur(&cfg, bytes, ext).await,
        other => Err(format!("图床 {} 暂未支持", other)),
    }
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

/// 对象键：把配置里的 path 与随机文件名拼起来，去掉多余的斜杠
pub(crate) fn object_key(path: &str, filename: &str) -> String {
    let prefix = path.trim().trim_matches('/');
    if prefix.is_empty() {
        filename.to_string()
    } else {
        format!("{}/{}", prefix, filename)
    }
}

/// 唯一文件名：毫秒时间戳 + 纳秒尾数 + 进程内序号（多标签同时粘贴不撞名）
pub(crate) fn unique_name(ext: &str) -> String {
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
}
