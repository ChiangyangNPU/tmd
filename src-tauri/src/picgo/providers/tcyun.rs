//! 腾讯云 COS 图床：PUT Object + COS v5 签名（两级 HMAC-SHA1）。

use serde_json::Value;

use crate::picgo::config::{field, need};
use crate::picgo::http::mime_of;
use crate::picgo::object_key;
use crate::picgo::sign::cos_signature;

/// 腾讯云 COS：PUT Object + COS v5 签名（两级 HMAC-SHA1）
pub(crate) async fn upload_tcyun(
    cfg: &Value,
    bytes: &[u8],
    ext: &str,
    filename: &str,
) -> Result<String, String> {
    let secret_id = need(cfg, "secretId")?;
    let secret_key = need(cfg, "secretKey")?;
    let bucket = need(cfg, "bucket")?;
    let app_id = need(cfg, "appId")?;
    let area = need(cfg, "area")?;
    let key = object_key(field(cfg, "path"), filename);
    let host = format!("{}-{}.cos.{}.myqcloud.com", bucket, app_id, area);
    let now = chrono::Utc::now().timestamp();
    // 签名有效期 1 小时，与 COS 控制台建议一致
    let sign_time = format!("{};{}", now, now + 3600);
    let signature = cos_signature(secret_key, &sign_time, &host, &key);
    let authorization = format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list=host&q-url-param-list=&q-signature={}",
        secret_id, sign_time, sign_time, signature
    );
    let url = format!("https://{}/{}", host, key);
    let resp = reqwest::Client::new()
        .put(&url)
        .header("Authorization", authorization)
        .header("Content-Type", mime_of(ext))
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| format!("tcyun 请求失败：{}", e))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "tcyun 上传被拒：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(url)
}
