//! 阿里云 OSS 图床：PUT Object + OSS V1 签名（HMAC-SHA1）。

use serde_json::Value;

use crate::picgo::config::{field, need};
use crate::picgo::http::mime_of;
use crate::picgo::object_key;
use crate::picgo::sign::oss_signature;

/// 阿里云 OSS：PUT Object + OSS V1 签名（HMAC-SHA1）
pub(crate) async fn upload_aliyun(
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
