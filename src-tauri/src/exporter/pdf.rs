//! PDF 导出（print 通道，macOS 降级路径）。

use crate::export_native;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// print：全文档 createPDF + 保存框落盘（对应 ipc-files.cjs 的 IPC.print）。
///
/// macOS 降级说明（已入档 docs/spike-tauri.md）：WKWebView 无 printToPDF
/// 等价物，createPDF 是 web page 矩形直出——**页尺寸/页边距/页眉页脚/
/// 大纲选项暂不生效**（Electron 版走 Chromium 打印管线支持全部选项）。
/// 文档尺寸量自 `.ProseMirror` 内容底缘（编辑器为定高容器，
/// documentElement.scrollHeight 只给视口高——阶段 B 已知结论）。
#[tauri::command]
pub(crate) async fn tmd_print(
    app: AppHandle,
    window: WebviewWindow,
    name: Option<String>,
    options: Option<serde_json::Value>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Ok(false);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_print(&app, name.as_deref(), options))
        .await
        .map_err(|e| format!("PDF 导出异常: {}", e))?
}

/// print 实主体（阻塞线程执行）：测量 → 保存框 → 平台 PDF 原语 → 落盘。
/// 任何失败记日志后返回 false（对齐 Electron 版 catch → false 口径，
/// 渲染层 exportPdf 不 catch，Err 会变成未处理 rejection）。
///
/// 平台差异：mac 为 createPDF 整页矩形直出（options 无消费方）；Windows 为
/// PrintToPdf 分页打印管线，options（页尺寸/朝向/边距/页眉页脚）生效。
fn run_print(
    app: &AppHandle,
    name: Option<&str>,
    options: Option<serde_json::Value>,
) -> Result<bool, String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(false);
    };
    let outcome = (|| -> Result<(), String> {
        // 全文档尺寸：.ProseMirror 内容底缘（web page 坐标），无编辑器时兜底
        let metrics = export_native::eval_js(
            &win,
            "JSON.stringify((()=>{const el=document.querySelector('.ProseMirror'); \
             if(!el) return {w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}; \
             const r=el.getBoundingClientRect(); \
             return {w:Math.max(document.documentElement.scrollWidth,Math.ceil(r.right)),\
                     h:Math.ceil(r.bottom+window.scrollY)};})())",
        )?;
        let v: serde_json::Value =
            serde_json::from_str(&metrics).map_err(|e| format!("尺寸解析失败: {}", e))?;
        let (w, h) = (
            v["w"].as_f64().unwrap_or(0.0),
            v["h"].as_f64().unwrap_or(0.0),
        );
        if w <= 0.0 || h <= 0.0 {
            return Err("文档尺寸测量失败".to_string());
        }
        // 默认文件名：文档名剥 .md/.markdown 后净化（对齐 ipc-files.cjs）
        let raw = name.unwrap_or("").trim();
        let stripped = raw
            .strip_suffix(".markdown")
            .or_else(|| raw.strip_suffix(".md"))
            .unwrap_or(raw)
            .trim();
        let base = if stripped.is_empty() {
            "导出"
        } else {
            stripped
        };
        let safe: String = base
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        let mut dialog = app
            .dialog()
            .file()
            .set_file_name(format!("{}.pdf", safe))
            .add_filter("PDF", &["pdf"]);
        // 对话框标题：插件 Rust API 无对应项（Electron 版 title 仅提示性）
        dialog = dialog.set_title("导出 PDF");
        let picked = dialog
            .blocking_save_file()
            .and_then(crate::commands::files::dialog_path_string);
        let Some(path) = picked else {
            return Ok(()); // 用户取消：不算失败
        };
        // 把文档名并入 options 供页眉标题使用（Windows 打印管线消费）
        let mut opts = options.unwrap_or_else(|| serde_json::json!({}));
        if let (Some(obj), Some(n)) = (opts.as_object_mut(), name.filter(|n| !n.is_empty())) {
            obj.entry("title").or_insert(serde_json::json!(n));
        }
        let bytes = export_native::capture_full_pdf(&win, w, h, Some(&opts))?;
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {}", path, e))?;
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(true),
        Err(err) => {
            if let Some(logger) = crate::logger::global() {
                logger.log(
                    "error",
                    "main",
                    &format!("PDF 导出失败: {}", err),
                    None,
                    &crate::logger::LogMeta::default(),
                );
            }
            Ok(false)
        }
    }
}
