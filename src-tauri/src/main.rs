// Windows release 不弹控制台窗口（GUI 子系统）；dev 保留控制台看 cargo 日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! TMD Tauri 壳层（spike 通过后的正式迁移起点，双壳共存——Electron 壳不受影响）。
//!
//! 架构：`window.tmdAPI` 契约（src/native.ts）由本壳经 initialization_script
//! 注入 Proxy 门面实现；纯逻辑按 electron/ 的模块边界下沉到独立模块
//! （text_file / search / wikilinks / watcher / history / menu / shell / ai_* /
//! fsops / themes / export_assets），与 JS 版逐语义对齐并可单测。
//!
//! 通道进度：43 条 invoke + 7 条事件订阅已实现——**权威清单与各模块对齐说明、
//! 已知缺口见 docs/spike-tauri.md**（此处不再枚举，避免两处清单漂移）。
//! 未实现通道 no-op + console.warn，不阻塞启动（渲染层的 `!native` 降级判断
//! 不受影响）。identifier 使用 com.chiangyang.tmd.spike，userData 与 Electron
//! 版完全隔离。
//!
//! @author chiangyang

// 验收模式 JS 驱动：复用 export_native::eval_js，故与导出原语同平台集合（mac/Win）
#[cfg(any(target_os = "macos", windows))]
mod acceptance;
mod ai;
mod ai_client;
mod ai_config;
mod bootstrap;
mod commands;
mod error;
mod export_assets;
// 导出链平台原语：同名模块按平台选实现，exporter.rs 的编排层零分叉
// - macOS：objc2 直调 WKWebView（export_native.rs）
// - Windows：WebView2 COM 直调（export_native_win.rs）
// 平台无关片段（内容尺寸的 JS 与解析）在 export_native_common.rs
#[cfg(target_os = "macos")]
mod export_native;
#[cfg(windows)]
#[path = "export_native_win.rs"]
mod export_native;
#[cfg(any(target_os = "macos", windows))]
mod export_native_common;
// 窗口形态矩阵探针为 mac 阶段 B 验证工具，不参与 Windows 编译
#[cfg(target_os = "macos")]
// 开发期调试设施：仅 debug 构建或显式 --features dev-tools 时编入发布形态
#[cfg(any(debug_assertions, feature = "dev-tools"))]
mod export_probe;
mod exporter;
mod fsops;
mod history;
mod logger;
mod menu;
mod picgo;
mod recent;
mod search;
mod shell;
mod text_file;
mod themes;
mod updater;
mod watcher;
mod wikilinks;
// 窗口几何持久化（位置尺寸最大化记录 / 启动恢复 / 多显示器钳制）
mod window_state;
// macOS 最大化/还原的自绘逐帧缩放（原生 zoom 过渡期间页面不重排）
#[cfg(target_os = "macos")]
mod win_anim;

fn main() {
    bootstrap::run()
}
