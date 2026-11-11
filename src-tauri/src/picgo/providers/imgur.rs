//! Imgur 图床：form 上传 base64，Client-ID 鉴权。

use base64::Engine as _;
use serde_json::Value;

use crate::picgo::config::{brief, need};

/// Imgur：form 上传 base64，Client-ID 鉴权
pub(crate) async fn upload_imgur(cfg: &Value, bytes: &[u8], ext: &str) -> Result<String, String> {
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
