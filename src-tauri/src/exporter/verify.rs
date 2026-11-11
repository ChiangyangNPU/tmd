//! 端到端管线验证（spike 自动验证，正式版随原型入口一并移除）。

use super::worker::{ExporterState, Job, TASK_TIMEOUT};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// 端到端管线验证（TMD_SPIKE_EXPORT_RUN=1 启动 8s 自动触发）：依次跑
/// longimage / word / epub 三个最小任务走**真实链路**——探边窗 +
/// exporterAPI 桥接 + capture 原语 + TS 侧分段/转换/打包 + base64 回传——
/// 产物落系统临时目录（tmd-export-verify.*，路径见日志），不走保存框，
/// 便于无人值守验证。word 含块级/行内公式与 mermaid 图（覆盖 OMML 注入
/// 与区域截帧栅格化两条分支）；epub 复用同款正文（覆盖 XMLSerializer +
/// 图片抽取 + EPUB 3 打包）。
pub(crate) fn verify_pipeline(app: &AppHandle) {
    let verify_css = "body{font-family:system-ui;padding:24px;line-height:1.8} h1{color:#b00020}";
    let tasks: Vec<(&str, serde_json::Value)> = vec![
        (
            "longimage",
            serde_json::json!({
                "lang": "zh-CN",
                "title": "管线验证",
                "bodyHtml": "<h1>正式导出链端到端验证</h1>\
                             <p>探边窗口 + exporterAPI 桥接 + capture 原语 + 分段拼接全链路。</p>\
                             <p>第二段：验证正文样式注入与多段文本排版。</p>\
                             <p>第三段：长图产物应为完整纵向拼接，非白、有标题色。</p>",
                "varsBlock": "",
                "css": verify_css,
                "isDark": false,
                "kind": "longimage",
                "baseDir": null,
            }),
        ),
        (
            "word",
            serde_json::json!({
                "lang": "zh-CN",
                "title": "Word 导出链验证",
                "bodyHtml": "<h1>Word 导出链验证</h1>\
                             <p>段落文本与块级公式：</p>\
                             $$E = mc^2$$\
                             <p>行内公式 $a^2+b^2=c^2$ 与后续文字。</p>\
                             <pre class=\"mermaid\">graph TD;\nA--&gt;B;\nB--&gt;C;</pre>\
                             <p>图表与公式之后的收尾段落，用于确认 docx 未截断。</p>",
                "varsBlock": "",
                "css": verify_css,
                "isDark": false,
                "kind": "word",
                "baseDir": null,
            }),
        ),
        (
            "epub",
            serde_json::json!({
                "lang": "zh-CN",
                "title": "ePub 导出链验证",
                "bodyHtml": "<h1>ePub 导出链验证</h1>\
                             <p>章节段落：XMLSerializer 序列化 + data URI 图片抽取。</p>\
                             <pre class=\"mermaid\">graph LR;\nX--&gt;Y;</pre>\
                             <p>收尾段落确认 epub 章节完整。</p>",
                "varsBlock": "",
                "css": verify_css,
                "isDark": false,
                "kind": "epub",
                "baseDir": null,
            }),
        ),
    ];
    for (kind, task) in tasks {
        let verdict = run_verify_task(app, task, &format!("tmd-export-verify.{kind}"));
        if let Some(logger) = crate::logger::global() {
            logger.log(
                if verdict.is_ok() { "warn" } else { "error" },
                "main",
                &format!(
                    "导出链验证[{kind}]: {}",
                    verdict.as_deref().unwrap_or_else(|e| e.as_str())
                ),
                None,
                &crate::logger::LogMeta::default(),
            );
        }
    }
}

/// 单个验证任务：入队 → 等回传字节 → 基础校验（zip 系产物查 PK 头，epub
/// 额外查未压缩 mimetype 条目）→ 落盘临时目录
fn run_verify_task(
    app: &AppHandle,
    task: serde_json::Value,
    out_name: &str,
) -> Result<String, String> {
    let state = app.state::<ExporterState>();
    let (reply_tx, reply_rx) = mpsc::channel();
    state
        .tx
        .send(Job {
            task,
            reply: reply_tx,
        })
        .map_err(|_| "导出服务已停止".to_string())?;
    let bytes = reply_rx
        .recv_timeout(TASK_TIMEOUT + Duration::from_secs(30))
        .map_err(|_| "管线验证超时".to_string())??;
    let kind = out_name.rsplit('.').next().unwrap_or("");
    if kind == "docx" || kind == "epub" {
        if !bytes.starts_with(b"PK\x03\x04") {
            return Err(format!("产物非 zip 容器（{} 字节）", bytes.len()));
        }
        if kind == "epub"
            && !bytes.iter().take(200).enumerate().any(|(i, _)| {
                bytes
                    .get(i..i + 20)
                    .is_some_and(|w| w == b"application/epub+zip")
            })
        {
            return Err("epub 缺少未压缩 mimetype 条目（打包顺序错误）".to_string());
        }
    }
    // 跨平台产物路径（Windows 无 /tmp；日志里给出实际路径便于验收）
    let out = std::env::temp_dir().join(out_name);
    std::fs::write(&out, &bytes).map_err(|e| format!("{}: {}", out.display(), e))?;
    Ok(format!("{}（{} 字节）", out.display(), bytes.len()))
}
