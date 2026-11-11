//! HTTP 请求体组装：手搓 multipart/form-data 与扩展名到 MIME 的推断。

/// 手工拼 multipart/form-data 体。
///
/// 不用 reqwest 的 multipart feature：它会引入额外 crate，网络受限时离线
/// 构建会失败。图床场景字段固定（文本字段 + 单个文件），自己拼可控且零依赖。
pub(crate) fn multipart_body(
    boundary: &str,
    text_fields: &[(&str, &str)],
    file_field: &str,
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    for (name, value) in text_fields {
        body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                boundary, name, value
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"{n}\"; filename=\"{f}\"\r\nContent-Type: {m}\r\n\r\n",
            b = boundary,
            n = file_field,
            f = filename,
            m = mime
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    body
}

pub(crate) fn mime_of(ext: &str) -> &'static str {
    match ext {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_body_bounds_fields() {
        let body = multipart_body(
            "B",
            &[("token", "t"), ("key", "k.png")],
            "file",
            "k.png",
            "image/png",
            b"xx",
        );
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains("name=\"token\"\r\n\r\nt\r\n"), "{}", text);
        assert!(text.contains("name=\"key\"\r\n\r\nk.png\r\n"), "{}", text);
        assert!(text.contains("filename=\"k.png\""), "{}", text);
        assert!(text.ends_with("--B--\r\n"), "结尾边界必须闭合：{}", text);
    }
}
