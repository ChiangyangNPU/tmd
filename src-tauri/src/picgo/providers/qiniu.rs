//! 七牛云图床：表单上传（token + key + file），URL 取用户配置的访问域名。

use serde_json::Value;

use crate::picgo::config::{field, need};
use crate::picgo::http::{mime_of, multipart_body};
use crate::picgo::sign::{qiniu_token, qiniu_upload_host};
use crate::picgo::unique_name;

/// 七牛云：表单上传（token + key + file），URL 取用户配置的访问域名
pub(crate) async fn upload_qiniu(
    cfg: &Value,
    bytes: &[u8],
    ext: &str,
    filename: &str,
) -> Result<String, String> {
    let access_key = need(cfg, "accessKey")?;
    let secret_key = need(cfg, "secretKey")?;
    let bucket = need(cfg, "bucket")?;
    // 七牛配置项没有 path，对象键直接用随机文件名
    let key = filename.to_string();
    let deadline = chrono::Utc::now().timestamp() + 3600;
    let token = qiniu_token(access_key, secret_key, bucket, &key, deadline);
    let host = qiniu_upload_host(field(cfg, "area"));
    let boundary = format!("----tmd{}", unique_name(""));
    let body = multipart_body(
        &boundary,
        &[("token", &token), ("key", &key)],
        "file",
        &format!("tmd{}", ext),
        mime_of(ext),
        bytes,
    );
    let resp = reqwest::Client::new()
        .post(format!("https://{}/", host))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("qiniu 请求失败：{}", e))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "qiniu 上传被拒：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let base = need(cfg, "url")?;
    Ok(format!("{}/{}", base.trim_end_matches('/'), key))
}
