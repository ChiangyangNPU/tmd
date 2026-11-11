//! 又拍云图床：PUT + Basic Auth（操作员账号:密码），URL 取用户配置的访问域名。

use serde_json::Value;

use crate::picgo::config::need;
use crate::picgo::http::mime_of;

/// 又拍云：PUT + Basic Auth（操作员账号:密码），URL 取用户配置的访问域名
pub(crate) async fn upload_upyun(
    cfg: &Value,
    bytes: &[u8],
    ext: &str,
    filename: &str,
) -> Result<String, String> {
    let bucket = need(cfg, "bucket")?;
    let operator = need(cfg, "operator")?;
    let password = need(cfg, "password")?;
    let key = filename.to_string();
    let resp = reqwest::Client::new()
        .put(format!("https://v0.api.upyun.com/{}/{}", bucket, key))
        .basic_auth(operator, Some(password))
        .header("Content-Type", mime_of(ext))
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| format!("upyun 请求失败：{}", e))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "upyun 上传被拒：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let base = need(cfg, "url")?;
    Ok(format!("{}/{}", base.trim_end_matches('/'), key))
}
