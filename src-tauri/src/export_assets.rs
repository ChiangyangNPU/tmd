//! 离线 HTML 导出的本地资源加载（electron/export-assets.cjs 的 Rust 移植）。
//!
//! dist/export-assets 由 scripts/copy-export-assets.mjs 在 build 后生成：
//! mermaid/katex/auto-render 三个 JS + katex.min.css（woff2 字体内联成
//! data URI，保证单文件离线可渲染）。资源缺失时返回 None，渲染层回退 CDN。
//!
//! 与 JS 版逐项对齐（JS 版保留服务 Electron 壳，改动需两处同步）：
//! - 内联 JS/CSS 转义闭合标签（防提前截断脚本）
//! - KaTeX CSS 去掉 woff/ttf 回退，woff2 全部转 data URI（去重后逐个读字体）
//! - 结果缓存（JS 用 Promise 缓存；Rust 用 OnceLock，缺失也缓存为已探明）

use base64::{engine::general_purpose::STANDARD, Engine as _};
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportAssets {
    pub mermaid_js: String,
    pub katex_js: String,
    pub katex_auto_render_js: String,
    pub katex_css: String,
}

/// 内联 JS 放进 <script> 前转义闭合标签（大小写不敏感，与 JS /gi 一致）
pub(crate) fn escape_script(js: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)</script").expect("escape 正则编译失败"))
        .replace_all(js, "<\\/script")
        .into_owned()
}

/// 内联 CSS 放进 <style> 前转义闭合标签（防御性处理，大小写不敏感）
pub(crate) fn escape_style(css: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)</style").expect("escape 正则编译失败"))
        .replace_all(css, "<\\/style")
        .into_owned()
}

/// 资源目录候选：dev 下 tauri 的工作目录是 src-tauri（../dist），
/// 也兼容从仓库根启动（./dist）。生产打包形态切换时再补资源嵌入。
fn asset_dir_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("../dist/export-assets"),
        PathBuf::from("dist/export-assets"),
    ]
}

/// 把 KaTeX CSS 的 woff/ttf 回退去掉，woff2 全部转 data URI。
fn inline_katex_css(dir: &Path) -> Option<String> {
    let css = std::fs::read_to_string(dir.join("katex.min.css")).ok()?;
    let re_woff = regex::Regex::new(r#",url\(fonts/[^)]+\.woff\) format\("woff"\)"#).ok()?;
    let re_ttf = regex::Regex::new(r#",url\(fonts/[^)]+\.ttf\) format\("truetype"\)"#).ok()?;
    let re_name = regex::Regex::new(r#"url\(fonts/([^)]+\.woff2)\)"#).ok()?;
    let css = re_woff.replace_all(&css, "");
    let css = re_ttf.replace_all(&css, "");
    let mut result = css.into_owned();
    let names: Vec<String> = re_name
        .captures_iter(&result)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    for name in names {
        if !seen.insert(name.clone()) {
            continue;
        }
        let data = std::fs::read(dir.join("fonts").join(&name)).ok()?;
        result = result.replace(
            &format!("url(fonts/{})", name),
            &format!("url(data:font/woff2;base64,{})", STANDARD.encode(data)),
        );
    }
    Some(escape_style(&result))
}

/// 加载并缓存导出资源；缺失时返回 None
pub(crate) fn load_export_assets() -> Option<ExportAssets> {
    static CACHE: OnceLock<Option<ExportAssets>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            for dir in asset_dir_candidates() {
                let dir = Path::new(&dir);
                let (Ok(mermaid), Ok(katex), Ok(auto)) = (
                    std::fs::read_to_string(dir.join("mermaid.min.js")),
                    std::fs::read_to_string(dir.join("katex.min.js")),
                    std::fs::read_to_string(dir.join("auto-render.min.js")),
                ) else {
                    continue;
                };
                let Some(katex_css) = inline_katex_css(dir) else {
                    continue;
                };
                return Some(ExportAssets {
                    mermaid_js: escape_script(&mermaid),
                    katex_js: escape_script(&katex),
                    katex_auto_render_js: escape_script(&auto),
                    katex_css,
                });
            }
            None
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_script_neutralizes_closing_tags() {
        assert_eq!(
            escape_script("a</script>b</SCRIPT>c"),
            "a<\\/script>b<\\/script>c"
        );
        assert_eq!(escape_style("a</style>b"), "a<\\/style>b");
    }

    #[test]
    fn katex_css_inlines_fonts_and_drops_fallbacks() {
        let root = std::env::temp_dir().join(format!("tmd-spike-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("export-assets");
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::write(
            dir.join("katex.min.css"),
            "@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format(\"woff2\"),url(fonts/KaTeX_Main-Regular.woff) format(\"woff\"),url(fonts/KaTeX_Main-Regular.ttf) format(\"truetype\")}",
        )
        .unwrap();
        std::fs::write(dir.join("fonts").join("KaTeX_Main-Regular.woff2"), b"WOFF2DATA").unwrap();
        let css = inline_katex_css(&dir).unwrap();
        let expected = STANDARD.encode(b"WOFF2DATA");
        assert!(css.contains(&format!("url(data:font/woff2;base64,{})", expected)));
        assert!(!css.contains(".woff)"));
        assert!(!css.contains(".ttf"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn load_returns_none_when_assets_missing() {
        // 当前工作目录无 dist/export-assets（单测环境）→ None
        let assets = load_export_assets();
        // 若开发目录恰好存在产物则跳过断言（不假设构建状态）
        let exists = asset_dir_candidates().iter().any(|p| p.exists());
        if !exists {
            assert!(assets.is_none());
        }
    }
}
