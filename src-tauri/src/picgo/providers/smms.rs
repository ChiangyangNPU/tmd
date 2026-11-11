//! SM.MS 图床：multipart 上传，Token 直接放 Authorization 头。

use serde_json::Value;

use crate::picgo::config::{brief, need};
use crate::picgo::http::{mime_of, multipart_body};
use crate::picgo::unique_name;

/// SM.MS：multipart 上传，Token 直接放 Authorization 头
pub(crate) async fn upload_smms(cfg: &Value, bytes: &[u8], ext: &str) -> Result<String, String> {
    let token = need(cfg, "token")?;
    let boundary = format!("----tmd{}", unique_name(""));
    let body = multipart_body(
        &boundary,
        &[],
        "smfile",
        &format!("tmd{}", ext),
        mime_of(ext),
        bytes,
    );
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
