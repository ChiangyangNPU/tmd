//! 主窗口：创建工厂（首次启动 / macOS Reopen 共用）与关闭确认。
//! 窗口形态细节（标题栏 / 防闪 / 几何恢复）的结论性注释随实现保留。

use serde_json::Value;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::shell::ShellState;
#[cfg(target_os = "macos")]
use crate::win_anim;
use crate::window_state::{self, WinStateTracker};

/// 注入到每个页面加载前的渲染层 shim：定义与 electron/preload.cjs 同名的
/// `window.tmdAPI`。已实现通道走 Tauri invoke；其余通道 no-op + 一次性告警。
///
/// 脚本正文独立在 `tmd-api-shim.js`（include_str! 编译期内嵌，不涉及运行时
/// 路径）：此前嵌在 main.rs 的 raw string 里，改一行通道要在大段 Rust 里找
/// 位置，且与渲染层契约（src/native.ts）对照时缺少独立文件的定位便利。
pub(super) const TMD_API_SHIM: &str = include_str!("../tmd-api-shim.js");

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
        // 带版本号：用户可直观确认当前运行版本；版本随 Cargo 对齐流程自动跟进
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
