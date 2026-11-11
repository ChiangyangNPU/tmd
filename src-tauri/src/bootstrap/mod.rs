//! 应用引导与生命周期：单实例/打开事件/主窗口工厂/关闭确认/待打开队列。
//!
//! 子模块分工：window（主窗口工厂 + 关闭确认）/ events（opened/Reopen/菜单/
//! 窗口事件处理器）/ probe（spike 环境变量探针与菜单调试动作，多块随发布
//! 前的验收节奏整体移除）。
//!
//! @author chiangyang

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::ai;
use crate::commands;
use crate::exporter;
use crate::history;
use crate::logger;
use crate::picgo;
use crate::shell::ShellState;
use crate::updater;
use crate::watcher::WatchState;
use crate::window_state::{self, WinStateTracker};

mod events;
mod probe;
mod window;

/// 待打开文件队列：渲染层 ready 前入队（文件关联早于渲染层就绪），
/// ready 命令或二次启动转交时冲刷（对应 main.cjs 的 pendingOpenPaths）。
/// ready 标志防止「渲染层监听注册前 emit 进真空」——Electron 版
/// queueOpenPath 的 `if (!app.isReady()) return` 同款语义。
#[derive(Default)]
pub(crate) struct PendingOpenPaths {
    pub(crate) queue: std::sync::Mutex<Vec<String>>,
    pub(crate) ready: AtomicBool,
}

/// 可打开扩展名（与渲染层白名单同口径）
fn is_openable_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

/// 入队；仅当渲染层已 ready 才冲刷，否则等 ready 命令补发
pub(crate) fn queue_open_path(app: &tauri::AppHandle, path: String) {
    if !is_openable_path(&path) {
        return;
    }
    {
        let pending = app.state::<PendingOpenPaths>();
        pending
            .queue
            .lock()
            .expect("pending open 锁中毒")
            .push(path);
        if !pending.ready.load(Ordering::SeqCst) {
            return; // 渲染层未就绪：留在队列，等 ready 冲刷
        }
    }
    flush_pending_open_paths(app);
}

/// 把排队中的待打开文件发给渲染层，并把窗口带到前台
pub(crate) fn flush_pending_open_paths(app: &tauri::AppHandle) {
    let paths = {
        let pending = app.state::<PendingOpenPaths>();
        let mut g = pending.queue.lock().expect("pending open 锁中毒");
        std::mem::take(&mut *g)
    };
    for path in paths {
        let _ = app.emit("tmd-open-path", &path);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 专职线程：等 PendingOpenPaths 就位（state 尚未 manage 时轮询等待）后
/// 把一批路径入队。opened 事件与单实例转交的公共路径——两者都在主线程
/// 回调里到达，整体挪出主线程再入队/冲刷（窗口操作经 Tauri 正常派发）。
fn relay_paths_to_renderer(app: tauri::AppHandle, paths: Vec<String>) {
    std::thread::spawn(move || {
        // Opened 可能早于 setup 完成（PendingOpenPaths 尚未 manage）：
        // 轮询等待而非 state() panic（原崩溃根因：早到事件在 AE 派发栈
        // 内同步 panic → abort；线程内 panic 则静默丢文档）
        for _ in 0..300 {
            if app.try_state::<PendingOpenPaths>().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        for path in paths {
            queue_open_path(&app, path);
        }
    });
}

/// 最大化状态去重标记（Resized 事件高频，只在状态翻转时推送）
pub(crate) struct MaximizedFlag(pub(crate) AtomicBool);

/// 应用入口：构建 Tauri 应用（插件/状态/setup/菜单/窗口事件/dispatch）并进入事件循环。
pub(crate) fn run() {
    let app = tauri::Builder::default()
        // 单实例锁：二次启动的 argv 转交主实例（官方要求该插件最先注册）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 二次实例转交同样在主线程回调里到达：与 RunEvent::Opened 同因，
            // 整体挪出主线程再入队/冲刷（窗口操作经 Tauri 正常派发）
            relay_paths_to_renderer(app.clone(), argv);
        }))
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：原语由插件承载（签名校验/下载/安装），
        // 端点与公钥在 tauri.conf.json 的 plugins.updater 配置
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(setup_app)
        .on_menu_event(events::handle_menu_event)
        .on_window_event(events::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::files::tmd_read_file,
            commands::files::tmd_save_file,
            commands::files::tmd_read_dir,
            commands::files::tmd_search_files,
            commands::files::tmd_wiki_scan,
            commands::files::tmd_watch_files,
            commands::files::tmd_watch_dirs,
            commands::files::tmd_list_history,
            commands::files::tmd_read_history,
            commands::shell::tmd_set_locale_info,
            commands::shell::tmd_sync_shortcuts,
            commands::shell::tmd_set_autosave_enabled,
            commands::shell::tmd_set_dirty,
            commands::shell::tmd_set_theme_source,
            commands::shell::tmd_win_minimize,
            commands::shell::tmd_win_max_toggle,
            commands::shell::tmd_win_close,
            commands::shell::tmd_recent_sync,
            commands::shell::tmd_recent_add,
            commands::shell::tmd_recent_clear,
            commands::shell::tmd_recent_remove,
            ai::tmd_ai_get_config,
            ai::tmd_ai_save_config,
            ai::tmd_ai_test,
            ai::tmd_ai_chat,
            ai::tmd_ai_abort,
            ai::tmd_ai_embed,
            picgo::tmd_picgo_get_config,
            picgo::tmd_picgo_save_config,
            picgo::tmd_picgo_upload,
            commands::files::tmd_save_image,
            commands::files::tmd_read_dropped_file,
            commands::files::tmd_open_external,
            commands::files::tmd_open_local_file,
            commands::files::tmd_reveal_in_folder,
            commands::files::tmd_delete_path,
            commands::files::tmd_create_file,
            commands::files::tmd_create_dir,
            commands::files::tmd_rename_path,
            commands::system::tmd_list_themes,
            commands::system::tmd_read_theme,
            commands::system::tmd_open_themes_dir,
            commands::system::tmd_get_export_assets,
            exporter::commands::tmd_export_run,
            exporter::commands::tmd_exporter_done,
            exporter::commands::tmd_exporter_capture,
            exporter::commands::tmd_exporter_read_image,
            exporter::pdf::tmd_print,
            commands::system::tmd_report_error,
            commands::shell::tmd_ready,
            commands::system::tmd_open_logs_dir,
            commands::files::tmd_open_file,
            commands::files::tmd_open_folder,
            commands::files::tmd_save_file_as,
            commands::export::tmd_export_as,
            updater::tmd_update_check,
            updater::tmd_update_download,
            updater::tmd_update_install,
            updater::tmd_update_set_auto,
            updater::tmd_doc_save_result
        ])
        .build(tauri::generate_context!())
        .expect("TMD (tauri spike) 启动失败");
    app.run(|_app, _event| {
        // 文件关联：Finder 双击 / 系统打开方式。
        // RunEvent::Opened 仅存在于 Apple 平台；Windows 的关联启动与二次双击
        // 都经单实例插件的 second-instance argv 转交（上方注册处已处理）。
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        events::handle_opened_event(_app, &_event);
        // macOS：关掉主窗口后点 Dock 图标（applicationShouldHandleReopen）
        // 重建主窗口；Electron 版对应 app 'activate' 分支。
        // 前提是先拦下「最后窗口销毁即退出」，否则进程已结束、事件不会到达
        #[cfg(target_os = "macos")]
        {
            events::handle_exit_requested_event(&_event);
            events::handle_reopen_event(_app, &_event);
        }
    });
}

/// setup 回调体（Builder 链上收敛为函数指针，见 run）。
/// 状态注册顺序即启动依赖顺序：logger → watcher → 导出服务 → 壳状态 →
/// 数据目录（AI/图床/更新器/窗口几何）→ 菜单 → 主窗口 → spike 探针 → 更新检查。
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // 本地日志（~/.tmd/logs）：panic hook 与渲染层异常上报都写这里；
    // 启动扫描崩溃目录补记上次运行留下的 minidump 线索（与 Electron 版共享资产根）
    let logger = logger::init_global(history::tmd_home());
    logger::install_panic_hook();
    logger::scan_new_dumps(&logger, &history::tmd_home());
    app.manage(logger);
    app.manage(WatchState::new(app.handle().clone()));
    // 离屏导出服务（Word/长图/ePub 专职 worker + 探边窗口）
    exporter::init(app.handle());
    app.manage(ShellState::new());
    app.manage(MaximizedFlag(AtomicBool::new(false)));
    app.manage(PendingOpenPaths {
        queue: std::sync::Mutex::new(Vec::new()),
        ready: AtomicBool::new(false),
    });
    // AI 配置存 userData（identifier 隔离，与 Electron 安装版互不相通）；
    // TMD_DATA_DIR 供验收/多实例调试做数据隔离，避免污染真实 userData
    let data_dir = match std::env::var("TMD_DATA_DIR") {
        Ok(dir) if !dir.is_empty() => {
            let path = std::path::PathBuf::from(dir);
            let _ = std::fs::create_dir_all(&path);
            path
        }
        _ => app.path().app_data_dir().expect("userData 目录不可用"),
    };
    app.manage(ai::AiState::new(data_dir.join("ai-config.json")));
    // 图床配置沿用 Electron 版的 picgo-config.json，老用户可直接复用
    app.manage(picgo::PicGoState::new(data_dir.join("picgo-config.json")));
    // 壳层持久化：主题与窗口几何在首帧前恢复（与 Electron createWindow 前恢复同口径）
    let shell_file = data_dir.join("shell-state.json");
    let persisted = window_state::read_shell_state(&shell_file);
    // 自动更新开关：与主题/窗口几何同存 shell-state.json，启动即恢复
    let auto_check = persisted
        .get("autoCheckUpdate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    app.manage(updater::UpdaterState::new(auto_check));
    app.manage(WinStateTracker::new(shell_file.clone()));
    // 启动即用中文默认文案建菜单；渲染层就绪后经 setLocaleInfo 按语言重建。
    // 仅 macOS：Windows 挂原生菜单会闪菜单栏且偏离 Electron 观感
    // （Electron 版 Win/Linux 是 setMenuBarVisibility(false) 隐藏菜单栏，
    // 快捷键由渲染层 keydown 兜底分发，见 src/main.ts 通用分支）
    #[cfg(target_os = "macos")]
    app.state::<ShellState>().rebuild_menu(app.handle());
    // 主窗口：首次创建与 macOS Reopen 重建共用同一工厂（几何/主题/
    // 最大化状态在工厂内从 shell-state 现读，重建语义与首次启动一致）
    window::create_main_window(app.handle())?;
    // spike 探针：环境变量触发的验收工具（TMD_SPIKE_*），见 probe 模块
    probe::spawn_env_probes(app.handle());
    // 自动更新：启动 5s 后按持久化开关自动检查（对应 Electron scheduleAutoCheck）
    updater::schedule_auto_check(app.handle().clone());
    Ok(())
}
