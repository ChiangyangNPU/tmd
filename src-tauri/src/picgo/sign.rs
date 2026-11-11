//! 签名与编码原语：HMAC-SHA1、hex、urlsafe base64，以及 OSS / COS / 七牛签名。

use base64::Engine as _;

/// 阿里云 OSS V1 签名：base64(HMAC-SHA1(secret, "PUT\n\n{type}\n{date}\n/{bucket}/{key}"))
///
/// 独立成函数便于单测覆盖 stringToSign 的拼接格式（换行位置错一位就会 403，
/// 而真实网络验证需要用户凭据）。
pub(crate) fn oss_signature(
    secret: &str,
    content_type: &str,
    date: &str,
    bucket: &str,
    key: &str,
) -> String {
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

/// COS v5 签名：
/// `SignKey = hex(HMAC-SHA1(SecretKey, KeyTime))`，
/// `StringToSign = "sha1\n{KeyTime}\n{sha1(HttpString)}\n"`，
/// `Signature = hex(HMAC-SHA1(SignKey, StringToSign))`，
/// 其中 `HttpString = "put\n/{key}\n\nhost={host}\n"`。
///
/// 拆出来便于单测：两级 HMAC 与换行位置错一处线上就是 403。
pub(crate) fn cos_signature(secret_key: &str, key_time: &str, host: &str, key: &str) -> String {
    let http_string = format!("put\n/{}\n\nhost={}\n", key, host);
    let string_to_sign = format!("sha1\n{}\n{}\n", key_time, sha1_hex(http_string.as_bytes()));
    let sign_key = hex_of(&hmac_sha1(secret_key.as_bytes(), key_time.as_bytes()));
    hex_of(&hmac_sha1(sign_key.as_bytes(), string_to_sign.as_bytes()))
}

/// 字节转小写十六进制（COS 签名要求 hex 而非 base64）
fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha1_hex(data: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    hex_of(&Sha1::digest(data))
}

/// URL 安全的 base64 且去掉填充（七牛 upload token 要求）
fn base64_urlsafe(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 七牛上传凭证：`ak:urlsafe_b64(HMAC-SHA1(sk, policy)):urlsafe_b64(policy)`
///
/// policy 用的是最小 JSON，字段顺序固定以便单测锁定；对象键由 unique_name
/// 生成（仅数字、连字符与扩展名），不含需要转义的字符。
pub(crate) fn qiniu_token(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    key: &str,
    deadline: i64,
) -> String {
    let policy = format!(
        "{{\"scope\":\"{}:{}\",\"deadline\":{}}}",
        bucket, key, deadline
    );
    let encoded = base64_urlsafe(policy.as_bytes());
    let sign = base64_urlsafe(&hmac_sha1(secret_key.as_bytes(), encoded.as_bytes()));
    format!("{}:{}:{}", access_key, sign, encoded)
}

/// 七牛按存储区域选上传域名，未知区域回落华东（z0）
pub(crate) fn qiniu_upload_host(area: &str) -> &'static str {
    match area.trim() {
        "z1" => "upload-z1.qiniup.com",
        "z2" => "upload-z2.qiniup.com",
        "na0" => "upload-na0.qiniup.com",
        "as0" => "upload-as0.qiniup.com",
        _ => "upload.qiniup.com",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn cos_signature_matches_external_reference() {
        // 期望值由 Python hashlib 对同一 HttpString / StringToSign 独立算出，
        // 锁定两级 HMAC 与换行位置（错一处线上即 403）
        let sig = cos_signature(
            "secret",
            "1700000000;1700003600",
            "bucket-1250000000.cos.ap-shanghai.myqcloud.com",
            "img/a.png",
        );
        assert_eq!(sig, "758f266448c6d0c2786fd0822217ded61fc133c3");
    }

    #[test]
    fn qiniu_token_matches_external_reference() {
        // 期望值同样由 Python hmac + urlsafe_b64 独立算出
        let token = qiniu_token("ak", "sk", "bucket", "abc.png", 1_700_003_600);
        assert_eq!(
            token,
            "ak:1h5LMzSUfc1s7n4VF2b9bxtiq68:eyJzY29wZSI6ImJ1Y2tldDphYmMucG5nIiwiZGVhZGxpbmUiOjE3MDAwMDM2MDB9"
        );
    }

    #[test]
    fn qiniu_region_hosts() {
        assert_eq!(qiniu_upload_host("z1"), "upload-z1.qiniup.com");
        assert_eq!(qiniu_upload_host("na0"), "upload-na0.qiniup.com");
        assert_eq!(qiniu_upload_host(""), "upload.qiniup.com");
        assert_eq!(qiniu_upload_host("unknown"), "upload.qiniup.com");
    }
}
