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
mod export_assets;
// 导出链平台原语：同名模块按平台选实现，exporter.rs 的编排层零分叉
// - macOS：objc2 直调 WKWebView（export_native.rs）
// - Windows：WebView2 COM 直调（export_native_win.rs）
#[cfg(target_os = "macos")]
mod export_native;
#[cfg(windows)]
#[path = "export_native_win.rs"]
mod export_native;
// 窗口形态矩阵探针为 mac 阶段 B 验证工具，不参与 Windows 编译
#[cfg(target_os = "macos")]
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
// macOS 最大化/还原的自绘逐帧缩放（原生 zoom 过渡期间页面不重排）
#[cfg(target_os = "macos")]
mod win_anim;

#[cfg(any(target_os = "macos", target_os = "ios"))]
use bootstrap::handle_opened_event;
use bootstrap::{
    confirm_discard_changes, create_main_window, queue_open_path, MaximizedFlag, PendingOpenPaths,
};
#[cfg(target_os = "macos")]
use bootstrap::{handle_exit_requested_event, handle_reopen_event};
use serde_json::Value;
use shell::{ShellState, WinStateTracker};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use watcher::WatchState;

fn main() {
    let app = tauri::Builder::default()
        // 单实例锁：二次启动的 argv 转交主实例（官方要求该插件最先注册）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 二次实例转交同样在主线程回调里到达：与 RunEvent::Opened 同因，
            // 整体挪出主线程再入队/冲刷（窗口操作经 Tauri 正常派发）
            let app = app.clone();
            std::thread::spawn(move || {
                // 转交理论只在应用完全启动后发生，但与 Opened 同因防护
                for _ in 0..300 {
                    if app.try_state::<PendingOpenPaths>().is_some() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                for path in argv {
                    queue_open_path(&app, path);
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：原语由插件承载（签名校验/下载/安装），
        // 端点与公钥在 tauri.conf.json 的 plugins.updater 配置
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
            let persisted = shell::read_shell_state(&shell_file);
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
            create_main_window(app.handle())?;
            // spike 阶段 B 后续：导出窗口形态矩阵自动验证（TMD_SPIKE_MATRIX=1）。
            // 不依赖主窗口内容，5s 后直接跑；须以 `open -a --env TMD_SPIKE_MATRIX=1`
            // 触发——直接后台启动的应用未激活，其窗口不合成（阶段 B 可见性约束）
            if std::env::var("TMD_SPIKE_MATRIX").as_deref() == Ok("1") {
                #[cfg(target_os = "macos")]
                {
                    let app = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        export_probe::run_matrix(&app);
                    });
                }
            }
            // spike 正式导出链端到端验证（TMD_SPIKE_EXPORT_RUN=1）：
            // 最小 longimage 任务走真实链路（探边窗/桥接/分段截图/拼接），
            // 产物 /tmp/tmd-export-verify.png；须 open -a 触发（应用激活）
            if std::env::var("TMD_SPIKE_EXPORT_RUN").as_deref() == Ok("1") {
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    exporter::verify_pipeline(&app);
                });
            }
            // Windows 原语三件套自测（视口截帧 / 区域裁剪 / PDF）：
            // 产物与像素统计落临时目录 + 日志，用于首落地验收（发布前移除）
            #[cfg(windows)]
            if std::env::var("TMD_SPIKE_EXPORT_OPS").as_deref() == Ok("1") {
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    export_native::verify_native(&app);
                });
            }
            // spike 阶段 B 原型自动验证：仅当 TMD_SPIKE_EXPORT=1 时启用
            // （启动 8 秒后文档已加载，执行全文档 PDF + 视口截图原语）
            if std::env::var("TMD_SPIKE_EXPORT").as_deref() == Ok("1") {
                #[cfg(target_os = "macos")]
                {
                    let app = app.handle().clone();
                    std::thread::spawn(move || {
                        let step = |msg: &str| {
                            eprintln!("[tmd-spike] {}", msg);
                            if let Some(logger) = logger::global() {
                                logger.log(
                                    "warn",
                                    "main",
                                    &format!("阶段B原型: {}", msg),
                                    None,
                                    &logger::LogMeta::default(),
                                );
                            }
                        };
                        std::thread::sleep(std::time::Duration::from_secs(8));
                        step("step1: 开始（8s 延迟结束）");
                        let Some(window) = app.get_webview_window("main") else {
                            step("窗口不存在");
                            return;
                        };
                        step("step2: read_content_metrics 前");
                        let metrics = export_native::read_content_metrics(&window);
                        step(&format!(
                            "step3: metrics={:?}（若 Err 则崩溃点在 evaluate）",
                            metrics.is_ok()
                        ));
                        let pdf = metrics.and_then(|(w, h)| {
                            step(&format!("step4: capture_full_pdf 前（{}x{}）", w, h));
                            export_native::capture_full_pdf(&window, w, h, None).and_then(|bytes| {
                                std::fs::write("/tmp/tmd-spike-export.pdf", &bytes)
                                    .map_err(|e| e.to_string())?;
                                step(&format!("step5: PDF 落盘 {} 字节", bytes.len()));
                                Ok(format!("PDF {} 字节（内容 {}x{}）", bytes.len(), w, h))
                            })
                        });
                        let png = export_native::capture_viewport_png(&window).and_then(|bytes| {
                            std::fs::write("/tmp/tmd-spike-export.png", &bytes)
                                .map_err(|e| e.to_string())?;
                            step(&format!("step6: PNG 落盘 {} 字节", bytes.len()));
                            Ok(format!("PNG {} 字节", bytes.len()))
                        });
                        step(&format!("step7: 完成 PDF={:?} PNG={:?}", pdf, png));
                    });
                }
            }
            // 自动更新：启动 5s 后按持久化开关自动检查（对应 Electron scheduleAutoCheck）
            updater::schedule_auto_check(app.handle().clone());
            Ok(())
        })
        .on_menu_event(|app, event| {
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
                "spike-export-window-matrix" => {
                    // 阶段 B 后续：导出窗口形态判定矩阵（V1 隐藏对照 / V2 屏边探出候选）
                    #[cfg(target_os = "macos")]
                    {
                        let app = app.clone();
                        std::thread::spawn(move || export_probe::run_matrix(&app));
                    }
                }
                "spike-pdf" | "spike-snapshot" => {
                    #[cfg(target_os = "macos")]
                    {
                        let app = app.clone();
                        let is_pdf = id == "spike-pdf";
                        std::thread::spawn(move || {
                            let Some(window) = app.get_webview_window("main") else {
                                return;
                            };
                            let result = if is_pdf {
                                export_native::read_content_metrics(&window).and_then(|(w, h)| {
                                    let bytes =
                                        export_native::capture_full_pdf(&window, w, h, None)?;
                                    let out = std::path::Path::new("/tmp/tmd-spike-export.pdf");
                                    std::fs::write(out, &bytes).map_err(|e| e.to_string())?;
                                    Ok(format!(
                                        "/tmp/tmd-spike-export.pdf（{} 字节, 内容 {}×{}）",
                                        bytes.len(),
                                        w,
                                        h
                                    ))
                                })
                            } else {
                                export_native::capture_viewport_png(&window).and_then(|bytes| {
                                    let out = std::path::Path::new("/tmp/tmd-spike-export.png");
                                    std::fs::write(out, &bytes).map_err(|e| e.to_string())?;
                                    Ok(format!("/tmp/tmd-spike-export.png（{} 字节）", bytes.len()))
                                })
                            };
                            match result {
                                Ok(msg) => {
                                    eprintln!("[tmd-spike] 原型成功: {}", msg);
                                    if let Some(logger) = logger::global() {
                                        logger.log(
                                            "warn",
                                            "main",
                                            &format!("spike 原型成功: {}", msg),
                                            None,
                                            &logger::LogMeta::default(),
                                        );
                                    }
                                }
                                Err(err) => {
                                    eprintln!("[tmd-spike] 原型失败: {}", err);
                                    if let Some(logger) = logger::global() {
                                        logger.log(
                                            "error",
                                            "main",
                                            &format!("spike 原型失败: {}", err),
                                            None,
                                            &logger::LogMeta::default(),
                                        );
                                    }
                                }
                            }
                        });
                    }
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
        })
        .on_window_event(|window, event| {
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
                    let animating = win_anim::animating();
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
        })
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
            exporter::tmd_export_run,
            exporter::tmd_exporter_done,
            exporter::tmd_exporter_capture,
            exporter::tmd_exporter_read_image,
            exporter::tmd_print,
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
        handle_opened_event(_app, &_event);
        // macOS：关掉主窗口后点 Dock 图标（applicationShouldHandleReopen）
        // 重建主窗口；Electron 版对应 app 'activate' 分支。
        // 前提是先拦下「最后窗口销毁即退出」，否则进程已结束、事件不会到达
        #[cfg(target_os = "macos")]
        {
            handle_exit_requested_event(&_event);
            handle_reopen_event(_app, &_event);
        }
    });
}
