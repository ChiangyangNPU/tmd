//! 导出链纯函数：URL 解析 / MIME 白名单 / PNG 尺寸 / DIP 钳制。
//! 无 Tauri 依赖，全部可独立单测。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::time::Duration;

/// 尺寸/滚动变更后的渲染沉降（Electron 版为 2×rAF + 50ms；evaluateJavaScript
/// 不保证等待 Promise，rAF 无法回读，改用覆盖两帧时长的固定等待）
pub(crate) const SETTLE: Duration = Duration::from_millis(180);

/// 视口尺寸钳制范围（DIP，与 Electron 版一致）
pub(crate) const MIN_DIP: f64 = 200.0;
pub(crate) const MAX_DIP: f64 = 20000.0;

/// 单张本地图片读取上限（32MB，超限跳过而非撑爆导出内存）
pub(crate) const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 本地图片扩展名 → MIME（导出图片本地化白名单，其余一律不读）
pub(crate) const IMAGE_MIME: &[(&str, &str)] = &[
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".bmp", "image/bmp"),
    (".avif", "image/avif"),
    (".svg", "image/svg+xml"),
];

/// file:// URL → 本地绝对路径（与 electron/exporter.cjs fileUrlToPath 同口径）。
/// 兼容 POSIX 与 Windows 盘符形态；非 file: 协议、相对路径、非法转义返回 None。
pub(crate) fn file_url_to_path(file_url: &str) -> Option<String> {
    if !file_url.starts_with("file://") {
        return None;
    }
    let mut p = file_url["file://".len()..].to_string();
    // Windows 盘符形态：file:///E:/a.png → /E:/a.png 去掉多余前导斜杠
    let b = p.as_bytes();
    if b.len() >= 4 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        p = p[1..].to_string();
    }
    let decoded = percent_decode(&p)?;
    let d = decoded.as_bytes();
    let posix_abs = d.first() == Some(&b'/');
    let win_abs = d.len() >= 3
        && d[0].is_ascii_alphabetic()
        && d[1] == b':'
        && (d[2] == b'/' || d[2] == b'\\');
    if posix_abs || win_abs {
        Some(decoded)
    } else {
        None
    }
}

/// 仅解码文件路径中合法的百分号转义（两位十六进制）。
/// 孤立 `%` 或非法序列返回 None（与 decodeURIComponent 抛错口径一致：不猜）。
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 由扩展名取图片 MIME（大小写不敏感；白名单外返回 None）
pub(crate) fn image_mime_of(file_path: &str) -> Option<&'static str> {
    let lower = file_path.to_lowercase();
    IMAGE_MIME
        .iter()
        .find(|(ext, _)| lower.ends_with(ext))
        .map(|(_, mime)| *mime)
}

/// 读取本地图片为 data URI（白名单扩展名 + 大小上限），失败一律返回 None：
/// 文件不存在 / 无权限留 alt 文本，不阻断整篇导出（与 Electron 版口径一致）
pub(crate) fn read_image_as_data_uri(file_url: &str) -> Option<String> {
    let path = file_url_to_path(file_url)?;
    let mime = image_mime_of(&path)?;
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let buf = std::fs::read(&path).ok()?;
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(buf)))
}

/// 从 PNG 字节解析物理像素尺寸（IHDR 大端 u32；签名校验防误喂）
pub(crate) fn png_dims(png: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 24 || png[..8] != SIG {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Some((w, h))
}

/// DIP 钳制（与 Electron 版 clampDip 同口径）
pub(crate) fn clamp_dip(v: f64) -> f64 {
    v.max(MIN_DIP).min(MAX_DIP).round()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_to_path_accepts_posix_and_windows_forms() {
        assert_eq!(
            file_url_to_path("file:///Users/a/%E4%B8%AD.png"),
            Some("/Users/a/中.png".to_string())
        );
        assert_eq!(
            file_url_to_path("file:///E:/pics/a.png"),
            Some("E:/pics/a.png".to_string())
        );
        // 非 file: 协议 / 相对路径（无前导斜杠）/ 非法转义一律拒绝（不猜）
        assert_eq!(file_url_to_path("https://a/b.png"), None);
        assert_eq!(file_url_to_path("file://a/b.png"), None);
        assert_eq!(file_url_to_path("file:///Users/%zz.png"), None);
    }

    #[test]
    fn image_mime_of_whitelists_extensions() {
        assert_eq!(image_mime_of("/a/b.PNG"), Some("image/png"));
        assert_eq!(image_mime_of("/a/b.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_of("/a/b.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime_of("/a/b.txt"), None);
        assert_eq!(image_mime_of("/a/noext"), None);
    }

    #[test]
    fn read_image_rejects_missing_and_non_whitelisted() {
        assert_eq!(read_image_as_data_uri("/no/such/file.png"), None);
        assert_eq!(read_image_as_data_uri("file:///no/such/file.png"), None);
        // 扩展名白名单外：即便文件存在也不读
        let tmp = std::env::temp_dir().join("tmd-exporter-test.js");
        std::fs::write(&tmp, b"x").unwrap();
        assert_eq!(
            read_image_as_data_uri(&format!("file://{}", tmp.to_string_lossy())),
            None
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_image_inlines_whitelisted_png() {
        // 1×1 PNG（仅签名 + IHDR 头，读盘路径不校验完整性）
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
            0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
        ];
        let tmp = std::env::temp_dir().join("tmd-exporter-test.png");
        std::fs::write(&tmp, png).unwrap();
        let uri = read_image_as_data_uri(&format!("file://{}", tmp.to_string_lossy()));
        assert!(uri
            .as_deref()
            .unwrap_or("")
            .starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn png_dims_reads_ihdr() {
        // 签名(8) + IHDR 块长/类型(8) + 宽(4)=10 + 高(4)=20
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
            0, 0, 0, 0x0a, 0, 0, 0, 0x14,
        ];
        assert_eq!(png_dims(png), Some((10, 20)));
        assert_eq!(png_dims(b"not a png"), None);
    }

    #[test]
    fn clamp_dip_matches_electron_bounds() {
        assert_eq!(clamp_dip(100.0), 200.0); // 下限
        assert_eq!(clamp_dip(50000.0), 20000.0); // 上限
        assert_eq!(clamp_dip(924.4), 924.0); // 取整
    }
}
