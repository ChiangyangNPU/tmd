//! 应用事件处理器：文件关联打开 / macOS 退出拦截与 Reopen / 菜单动作 /
//! 窗口事件（几何持久化 / 关闭确认）。被 mod.rs 的 Builder 链挂接。

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

// logger 仅 handle_reopen_event（macOS 专属）使用
#[cfg(target_os = "macos")]
use crate::logger;
use crate::shell::ShellState;

use crate::window_state::WinStateTracker;

use super::window::confirm_discard_changes;
// create_main_window 仅 handle_reopen_event（macOS 专属）使用
#[cfg(target_os = "macos")]
use super::window::create_main_window;
use super::{MaximizedFlag, PendingOpenPaths};

/// macOS open-file / iOS 打开事件：路径入待打开队列
/// （Windows 不派发此事件，编译期排除，见 run 回调注释）。
///
/// **必须整体挪出 Apple Event 派发线程**：本回调在主线程的 odoc 事件派发
/// 栈内同步执行；若渲染层已 ready，queue_open_path 会当场冲刷并调用
/// unminimize/show/set_focus——从主线程向主线程派发窗口操作并阻塞等待，
/// panic/unwind 穿越 ObjC 帧直接 terminate（SIGABRT，odoc 晚于 ready
/// 到达时必现；早到则入队、由 ready 命令线程冲刷而幸免——竞态由此而来）。
/// 挪到专职线程后：入队与冲刷都在非主线程，窗口操作经 Tauri 正常派发。
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn handle_opened_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::Opened { urls } = event {
        let paths: Vec<String> = urls
            .iter()
            .map(|url| {
                url.to_file_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| url.to_string())
            })
            .collect();
        super::relay_paths_to_renderer(app.clone(), paths);
    }
}

/// macOS「关窗≠退出」：最后一个窗口销毁时阻止事件循环退出，交给 Reopen 重建。
///
/// Tauri 在最后一个窗口 Destroyed 后统一发 `ExitRequested { code: None }`
/// 并退出循环（不分平台）；macOS 需按平台惯例拦下，否则进程已结束，
/// Dock 点击永远不会派发 Reopen。显式退出（Cmd+Q / `app.exit`）带退出码，
/// 必须放行；Windows/Linux 保持关窗即退出，不调用本函数。
#[cfg(target_os = "macos")]
pub(crate) fn handle_exit_requested_event(event: &tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if code.is_none() {
            api.prevent_exit();
        }
    }
}

/// macOS Reopen（NSApplicationDelegate applicationShouldHandleReopen）：
/// 关掉主窗口后点 Dock 图标时重建主窗口（Electron 版靠 app 'activate' 同款行为）。
///
/// 已有窗口（关窗前先最小化/隐藏的情况）只做前置，不重复创建。
/// 窗口创建必须离开事件派发主线程——与 handle_opened_event 同因：run 回调
/// 跑在主线程的事件派发栈内，窗口操作同步回主线程会自等/panic。
#[cfg(target_os = "macos")]
pub(crate) fn handle_reopen_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    // 变体带 #[non_exhaustive]，外部匹配必须带 ..
    let tauri::RunEvent::Reopen {
        has_visible_windows,
        ..
    } = event
    else {
        return;
    };
    let has_visible_windows = *has_visible_windows;
    if let Some(window) = app.get_webview_window("main") {
        if !has_visible_windows {
            let _ = window.show();
            let _ = window.unminimize();
        }
        let _ = window.set_focus();
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // 连点 Dock 图标可能派发多次 Reopen：线程内二次确认避免建出两个主窗口
        if app.get_webview_window("main").is_some() {
            return;
        }
        if let Err(err) = create_main_window(&app) {
            if let Some(logger) = logger::global() {
                logger.log(
                    "error",
                    "main",
                    &format!("重建主窗口失败: {}", err),
                    None,
                    &logger::LogMeta::default(),
                );
            }
        }
    });
}

/// 菜单动作分发（Builder.on_menu_event 挂接）：壳内处理的动作就地处理，
/// 其余统一 emit 给渲染层（与 Electron sendToRenderer(IPC.menu) 对应）。
pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let shell = app.state::<ShellState>();
    let id = event.id.0.clone();
    match id.as_str() {
        // 自动保存 checkbox：muda 已自动翻转，回读翻转后的状态同步渲染层
        "autosave" => {
            if let Some(checked) = shell.autosave_checked_after_click() {
                shell.set_autosave_enabled(checked);
                let _ = app.emit("tmd-autosave", checked);
            }
        }
        "recent-empty" => {}
        // macOS 菜单退出（Cmd+Q）：有未保存修改先确认再退出。
        // 必须显式 app.exit(0) 带退出码——「最后窗口关闭」触发的
        // ExitRequested 是 code=None，会被防退出逻辑拦下（见
        // handle_exit_requested_event）
        "quit" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if confirm_discard_changes(&app) {
                    app.exit(0);
                }
            });
        }
        "clear-recent" => {
            // 清空动作交渲染层执行（localStorage 是唯一权威），口径同 JS 版
            let _ = app.emit("tmd-menu", "clear-recent".to_string());
        }
        // 视图：重新载入与 Electron viewMenu 的 reload 同语义——不弹未保存
        // 确认（文档恢复副本在 localStorage，重载即按原样恢复现场）
        "view-reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("location.reload()");
            }
        }
        // 开发者工具只在 debug 构建挂菜单项，处理分支保持同门控
        #[cfg(debug_assertions)]
        "view-devtools" => {
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
        }
        // spike 阶段 B 原型：Rust 侧直接驱动 WKWebView 原语（不经渲染层）
        #[cfg(any(debug_assertions, feature = "dev-tools"))]
        "spike-export-window-matrix" => {
            // 阶段 B 后续：导出窗口形态判定矩阵（V1 隐藏对照 / V2 屏边探出候选）
            super::probe::run_export_window_matrix(app);
        }
        "spike-pdf" | "spike-snapshot" => {
            super::probe::run_spike_proto(app, id == "spike-pdf");
        }
        _ => {
            if let Some(path) = id.strip_prefix("recent::") {
                let _ = app.emit("tmd-recent-open", path.to_string());
            } else {
                // 统一菜单动作分发（与 Electron sendToRenderer(IPC.menu) 对应）
                let _ = app.emit("tmd-menu", id);
            }
        }
    }
}

/// 窗口事件处理（Builder.on_window_event 挂接）：几何防抖落盘 /
/// 销毁时状态复位 / 关闭确认。
pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
            // 最大化状态推送（仅状态变化时发，对应 Electron maximize/unmaximize），
            // 变化瞬间同步落盘 winState（对应 JS 的 maximize/unmaximize 即时记录）
            let maximized = window.is_maximized().unwrap_or(false);
            let last = window.app_handle().state::<MaximizedFlag>();
            if last.0.swap(maximized, Ordering::SeqCst) != maximized {
                let _ = window.app_handle().emit("tmd-win-max-changed", maximized);
                window
                    .app_handle()
                    .state::<WinStateTracker>()
                    .save_now(window.app_handle());
            }
            // 几何记录 + 防抖 500ms 落盘（高频事件不刷盘；代数防抖——
            // 落盘线程醒来时代数未变才写）。**存逻辑坐标**：恢复端
            // builder.inner_size/position 吃逻辑值，物理直存会在 retina
            // 上双倍放大（A5 验收实测：存 2200 物理恢复成 2200 逻辑被
            // macOS 钳到全屏）。Electron getBounds 也是 DIP，语义对齐。
            // macOS 逐帧最大化动画会连发 Resized：跳过记录，避免把过渡
            // 中的中间尺寸当成「非最大化最近几何」落盘（下一帧即恢复）
            #[cfg(target_os = "macos")]
            let animating = crate::win_anim::animating();
            #[cfg(not(target_os = "macos"))]
            let animating = false;
            if animating {
                return;
            }
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                let scale = window.scale_factor().unwrap_or(1.0);
                let tracker = window.app_handle().state::<WinStateTracker>();
                tracker.record(
                    (pos.x as f64 / scale).round() as i32,
                    (pos.y as f64 / scale).round() as i32,
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                    maximized,
                );
                let gen_before = tracker.generation.load(Ordering::SeqCst);
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let tracker = app.state::<WinStateTracker>();
                    if tracker.generation.load(Ordering::SeqCst) == gen_before {
                        tracker.save_now(&app);
                    }
                });
            }
        }
        tauri::WindowEvent::Destroyed => {
            // 关闭时同步兜底：退出路径上防抖异步写不保证执行完
            window
                .app_handle()
                .state::<WinStateTracker>()
                .save_now(window.app_handle());
            // 渲染层随窗口销毁：复位 ready，避免 macOS 重建窗口期间
            // 打开文件的事件 emit 进「尚无监听者」的新 WebView 而丢文档
            window
                .app_handle()
                .state::<PendingOpenPaths>()
                .ready
                .store(false, Ordering::SeqCst);
            // 未保存标记随窗口一起作废：否则「放弃修改并关闭」后经 Dock
            // 重建的干净文档，下次关闭仍会弹未保存确认
            window.app_handle().state::<ShellState>().set_dirty(false);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 未保存关闭确认：原生对话框拦截（渲染层 window.confirm 不可靠，
            // Electron 同款原因）。破坏性按钮不做默认，默认落在「取消」。
            if !window.app_handle().state::<ShellState>().is_dirty() {
                return;
            }
            api.prevent_close();
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                if confirm_discard_changes(&app) {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.destroy();
                    }
                }
            });
        }
        _ => {}
    }
}
