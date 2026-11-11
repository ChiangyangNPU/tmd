//! 应用引导与生命周期：单实例/打开事件/主窗口工厂/关闭确认/待打开队列。
//!
//! @author chiangyang

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::ai;
use crate::commands;
#[cfg(any(target_os = "macos", windows))]
use crate::export_native;
#[cfg(target_os = "macos")]
use crate::export_probe;
use crate::exporter;
use crate::history;
use crate::logger;
use crate::picgo;
use crate::shell::ShellState;
use crate::updater;
use crate::watcher::WatchState;
#[cfg(target_os = "macos")]
use crate::win_anim;
use crate::window_state::{self, WinStateTracker};

/// 注入到每个页面加载前的渲染层 shim：定义与 electron/preload.cjs 同名的
/// `window.tmdAPI`。已实现通道走 Tauri invoke；其余通道 no-op + 一次性告警。
///
/// 脚本正文独立在 `tmd-api-shim.js`（include_str! 编译期内嵌，不涉及运行时
/// 路径）：此前嵌在 main.rs 的 raw string 里，改一行通道要在大段 Rust 里找
/// 位置，且与渲染层契约（src/native.ts）对照时缺少独立文件的定位便利。
const TMD_API_SHIM: &str = include_str!("tmd-api-shim.js");

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
        let app = app.clone();
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
}

/// 创建主窗口：首次启动（setup）与 macOS Reopen 重建共用同一工厂。
///
/// 窗口形态（尺寸/位置/最大化）与主题都从 `shell-state.json` 现读——首次启动
/// 走 restore_win_state，重建时 `Destroyed` 已把关闭前几何同步落盘，因此两条
/// 路径恢复语义完全一致，不存在「重建后回到默认 1280×820」的偏差。
pub(crate) fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let shell_file = app.state::<WinStateTracker>().path.clone();
    let persisted = window_state::read_shell_state(&shell_file);
    let restored_theme = match persisted.get("themeSource").and_then(Value::as_str) {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    let display_rects = window_state::monitor_rects(&app.available_monitors().unwrap_or_default());
    let restored = window_state::restore_win_state(&persisted, &display_rects);

    let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        // 带版本号：双轨共存期与 Electron 线（0.1.7）窗口可区分；
        // 版本随 Cargo 对齐流程自动跟进
        .title(format!("TMD {}", app.package_info().version))
        .min_inner_size(940.0, 600.0)
        .initialization_script(TMD_API_SHIM);
    if let Some(theme) = restored_theme {
        builder = builder.theme(Some(theme));
    }
    // 标题栏对齐 Electron 壳观感（electron/main.cjs:374-376）：
    // Win/Linux titleBarStyle 'hidden' → decorations(false) 全自绘（拖拽区与
    // 最大化/关闭由 shim 的拖拽处理 + html.win 自绘按钮承担）；
    // macOS 'hiddenInset' → Overlay 隐藏标题条 + 红绿灯悬浮工具栏，
    // 需 tauri.conf.json 开 macOSPrivateApi（内容延伸到标题栏下）。
    // traffic_light_position 语义与 Electron trafficLightPosition 不同（实测
    // 校准 2026-10-27）：x 为按钮原点（圆心=x+7），y 直接映射圆心高度
    // （圆心≈y−2.2）。Electron (16,16) 的圆心在 (23,23)，故此处 (16,25)；
    // 扩大的虚拟标题栏容器不拦截内容点击（y=40 实测按钮仍可点）
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 25.0));
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }
    // 首帧防闪（三平台）：隐藏创建 + 绘制就绪后再上屏，对齐 Electron 版
    // show:false + ready-to-show 的时序。WKWebView/WebView2 创建后到首帧
    // 绘制前露出的是默认白底（暗色/自定义主题下必闪）。
    // - 上屏通道一：Windows/Linux 走页面加载完成（此时 boot.js 同步挂好
    //   深浅类与预设属性，工具栏已可绘制）
    // - 上屏通道二：三平台共有——渲染层 ready（boot 末尾，文件主题经 IPC
    //   异步注入完毕）时经 flush_pending_open_paths 的 show 上屏
    //   （macOS 只走这条：boot 里的 await 晚于页面加载完成，file 主题在
    //   Finished 时可能未注入，提前上屏会闪内置配色）
    // - 兜底：8s 看门狗强制上屏（页面加载失败/渲染层崩溃时窗口不能永久隐藏）
    builder = builder.visible(false);
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = window.show();
            }
        });
    }
    // 底色跟随持久化主题（#1e2127 / #ffffff，与 Electron SHELL_BG 同值）：
    // 兜底「已上屏但首帧未合成」的瞬间——即便露出窗口底色也是主题色而非白
    let shell_bg = match restored_theme {
        Some(tauri::Theme::Dark) => tauri::window::Color(30, 33, 39, 255),
        _ => tauri::window::Color(255, 255, 255, 255),
    };
    builder = builder.background_color(shell_bg);
    match restored {
        Some(win) => {
            builder = builder.inner_size(win.width, win.height);
            if let (Some(x), Some(y)) = (win.x, win.y) {
                builder = builder.position(x as f64, y as f64);
            }
        }
        None => {
            builder = builder.inner_size(1280.0, 820.0);
        }
    }
    let window = builder.build()?;
    if restored.is_some_and(|w| w.maximized) {
        // macOS：先记下正常 frame，用户双击还原时才有几何可回（原生 zoom 不经过 win_anim）
        #[cfg(target_os = "macos")]
        win_anim::remember_current_frame(&window);
        let _ = window.maximize();
    }
    // 隐藏创建的上屏兜底（见上方「首帧防闪」）：正常路径是页面加载完成
    // （Win/Linux）或渲染层 ready（三平台）触发 show；渲染层加载失败时
    // 不能让窗口永久隐藏——8s 后强制上屏，用户至少能看到错误页
    {
        let win = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            if !win.is_visible().unwrap_or(true) {
                let _ = win.show();
            }
        });
    }
    Ok(window)
}

/// 有未保存修改时弹原生确认框，返回是否允许丢弃修改继续（无修改直接放行）。
///
/// 关窗（CloseRequested）与菜单退出（quit）共用，保证两条离开路径口径一致。
/// 阻塞式弹窗必须在线程里调用，不能占住事件派发线程。
pub(crate) fn confirm_discard_changes(app: &tauri::AppHandle) -> bool {
    if !app.state::<ShellState>().is_dirty() {
        return true;
    }
    let discard = app
        .dialog()
        .message("关闭前会丢失未保存的内容。")
        .title("有未保存的修改")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "放弃修改并关闭".to_string(),
            "取消".to_string(),
        ))
        .blocking_show();
    if discard {
        // 与 Electron clearRendererRecoveryCopy 同语义：窗口销毁前清渲染层
        // 恢复副本（localStorage 的 tmd:doc:v1，键名与 store.ts DOC_KEY 同步，
        // Electron 侧同款硬编码）。不清的话「已放弃」的内容下次启动会以恢复
        // 副本复活——v0.2.0 实测：脏文档放弃关闭后每次启动都恢复同一份未命名。
        // 窗口已不存在（极端时序）时跳过，不影响关闭流程。
        if let Some(w) = app.get_webview_window("main") {
            let _ =
                crate::export_native::eval_js(&w, "localStorage.removeItem('tmd:doc:v1'); 'ok'");
        }
    }
    discard
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

/// 最大化状态去重标记（Resized 事件高频，只在状态翻转时推送）
pub(crate) struct MaximizedFlag(pub(crate) AtomicBool);

/// 应用入口：构建 Tauri 应用（插件/状态/setup/菜单/窗口事件/dispatch）并进入事件循环。
pub(crate) fn run() {
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
