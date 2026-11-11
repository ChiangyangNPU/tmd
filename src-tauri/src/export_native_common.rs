//! 导出链平台无关的公共片段。
//!
//! 平台原语（`eval_js` / 截图 / PDF）由 `export_native.rs`（macOS，objc2 直调
//! WKWebView）与 `export_native_win.rs`（Windows，WebView2 COM）各自实现，两者
//! 以**同名模块 `export_native`** 按平台编译，编排层 `exporter.rs` 与服务端
//! 调用点零分叉。因此这里只放两平台逐字相同的片段：内容尺寸测量的 JS 与
//! 其返回值解析——不把平台差异硬塞进抽象层。
//!
//! @author chiangyang

/// 读取渲染层内容尺寸的 JS：scrollWidth/scrollHeight（web page 坐标）。
/// 返回值经 `eval_js` 拿到的是 JSON 字符串（见 `parse_content_metrics`）。
pub(crate) const CONTENT_METRICS_SCRIPT: &str = "JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})";

/// 解析 `CONTENT_METRICS_SCRIPT` 的返回值 → (宽, 高)。
/// 两平台的 `eval_js` 都返回字符串（Windows 侧 null 已归一为空串），
/// 故解析逻辑完全一致；字段缺失或非数值一律报「内容尺寸解析失败」。
pub(crate) fn parse_content_metrics(raw: &str) -> Result<(f64, f64), String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| Some((v["w"].as_f64()?, v["h"].as_f64()?)))
        .ok_or_else(|| "内容尺寸解析失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_metrics_payload() {
        assert_eq!(
            parse_content_metrics(r#"{"w":812,"h":4096}"#).unwrap(),
            (812.0, 4096.0)
        );
    }

    #[test]
    fn rejects_missing_or_non_numeric_fields() {
        assert!(parse_content_metrics(r#"{"w":812}"#).is_err());
        assert!(parse_content_metrics(r#"{"w":"812","h":4096}"#).is_err());
        assert!(parse_content_metrics("").is_err());
    }
}
