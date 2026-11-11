//! GitHub 图床：Contents API 提交 base64 内容，优先用 customUrl 拼访问地址。

use base64::Engine as _;
use serde_json::{json, Value};

use crate::picgo::config::{brief, field, need};
use crate::picgo::object_key;

/// GitHub Contents API：PUT 提交 base64 内容，优先用 customUrl 拼访问地址
pub(crate) async fn upload_github(
    cfg: &Value,
    bytes: &[u8],
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
