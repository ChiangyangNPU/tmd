//! 导出链 Windows 占位实现（与 exporter.rs 的命令面一一对应）。
//!
//! 模块切换由 main.rs 的 `#[path]` + cfg 完成：macOS 用真实实现
//! （objc2 直调 WKWebView 原语，export_native.rs），其余平台落此 stub。
//! Windows 等价原语（WebView2 PrintToPdfAsync / CapturePreview）待实现，
//! 评估与路线见 docs/Tauri迁移评估.md §3.3。
//!
//! 命令保持注册：渲染层调用得到结构化错误而非「通道缺失」，
//! 导出按钮走既有失败 toast 路径，不产生未处理异常。

use tauri::{AppHandle, WebviewWindow};

const PENDING: &str =
    "导出链尚未在 Windows 实现（WebView2 原语待补，见 docs/Tauri迁移评估.md §3.3）";

/// Windows 无离屏导出 worker 窗口与状态可管，注册期 no-op（对应 macOS init）
pub(crate) fn init(_app: &AppHandle) {}

/// spike 端到端验证入口：Windows 无实现，留痕即返
pub(crate) fn verify_pipeline(_app: &AppHandle) {
    eprintln!("[tmd-tauri-spike] verify_pipeline 跳过：{PENDING}");
}

/// 发起离屏导出任务（对应 exporter.rs tmd_export_run）
#[tauri::command]
pub(crate) async fn tmd_export_run(
    _app: AppHandle,
    _options: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    Err(PENDING.into())
}

/// 离屏页回传结果（对应 exporter.rs tmd_exporter_done）
#[tauri::command]
pub(crate) fn tmd_exporter_done(
    _window: WebviewWindow,
    _payload: serde_json::Value,
) -> Result<(), String> {
    Err(PENDING.into())
}

/// 离屏页截图原语（对应 exporter.rs tmd_exporter_capture）
#[tauri::command]
pub(crate) async fn tmd_exporter_capture(
    _window: WebviewWindow,
    _req: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    Err(PENDING.into())
}

/// 离屏页本地图片白名单读取（对应 exporter.rs tmd_exporter_read_image）
#[tauri::command]
pub(crate) fn tmd_exporter_read_image(
    _window: WebviewWindow,
    _file_url: String,
) -> Result<Option<String>, String> {
    Err(PENDING.into())
}

/// PDF 导出（对应 exporter.rs tmd_print）
#[tauri::command]
pub(crate) async fn tmd_print(
    _app: AppHandle,
    _window: WebviewWindow,
    _name: Option<String>,
    _options: Option<serde_json::Value>,
) -> Result<bool, String> {
    Err(PENDING.into())
}
