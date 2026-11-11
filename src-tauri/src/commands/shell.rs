//! @author chiangyang

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tauri::Manager;

use crate::bootstrap::{flush_pending_open_paths, PendingOpenPaths};
use crate::menu::RecentEntry;
use crate::shell::{self, ShellState, WinStateTracker};
#[cfg(target_os = "macos")]
use crate::win_anim;

// ---------- 应用级状态同步与窗口控制（electron/ipc-app.cjs 的 Rust 对应） ----------

/// 对应 native.ts setLocaleInfo：下发语言包 → 重建菜单；返回映射后的排序区域。
#[tauri::command]
pub(crate) fn tmd_set_locale_info(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    labels: HashMap<String, String>,
    locale: String,
) -> String {
    shell.set_locale_info(&app, labels, &locale)
}

/// 对应 native.ts syncShortcuts：快捷键配置 → 菜单 accelerator 重建。
#[tauri::command]
pub(crate) fn tmd_sync_shortcuts(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    shortcuts: HashMap<String, String>,
) {
    shell.sync_shortcuts(&app, shortcuts);
}

/// 对应 native.ts setAutosaveEnabled：设置面板同步开关（保持菜单勾选一致）。
#[tauri::command]
pub(crate) fn tmd_set_autosave_enabled(shell: tauri::State<'_, ShellState>, enabled: bool) {
    shell.set_autosave_enabled(enabled);
}

/// 对应 native.ts ready：渲染层就绪信号，冲刷排队中的待打开文件
/// （并恢复/聚焦窗口——对应 main.cjs 的 flushPendingOpenPaths）。
#[tauri::command]
pub(crate) fn tmd_ready(app: tauri::AppHandle, pending: tauri::State<'_, PendingOpenPaths>) {
    pending.ready.store(true, Ordering::SeqCst);
    flush_pending_open_paths(&app);
    // 验收模式（TMD_EVAL_SCRIPT 门控）：渲染层与壳层都就位后跑页面内断言
    #[cfg(any(target_os = "macos", windows))]
    crate::acceptance::maybe_start(&app);
}

/// 对应 native.ts setDirty：渲染层同步未保存状态（关闭确认用）。
#[tauri::command]
pub(crate) fn tmd_set_dirty(shell: tauri::State<'_, ShellState>, dirty: bool) {
    shell.set_dirty(dirty);
}

/// 对应 native.ts setThemeSource：窗口深浅主题随渲染层切换（handle + invoke，
/// 壳层切换完成后才返回，渲染层随后再翻页面——与 Electron 口径一致）。
/// spike 简化：不做 shell-state 持久化，重启回落系统默认。
#[tauri::command]
pub(crate) fn tmd_set_theme_source(
    window: tauri::WebviewWindow,
    is_dark: bool,
) -> Result<(), String> {
    use tauri::Theme;
    window
        .set_theme(Some(if is_dark { Theme::Dark } else { Theme::Light }))
        .map_err(|e| e.to_string())?;
    // 持久化到 shell-state.json（下次启动首帧即正确主题，对应 saveShellState）
    shell::save_shell_state(
        &window.app_handle().state::<WinStateTracker>().path.clone(),
        serde_json::json!({ "themeSource": if is_dark { "dark" } else { "light" } }),
    );
    Ok(())
}

/// 对应 native.ts winMinimize：自绘标题栏最小化。
#[tauri::command]
pub(crate) fn tmd_win_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

/// 对应 native.ts winMaximizeToggle：最大化 / 还原切换。
///
/// macOS 走自绘逐帧缩放（见 win_anim：原生 zoom 过渡期间 WKWebView 不重排，
/// 工具栏右侧按钮与居中标题会滞后到过渡结束）；其余平台最大化本身即时生效，
/// 沿用原生调用。
#[tauri::command]
pub(crate) fn tmd_win_max_toggle(window: tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        win_anim::toggle(&window);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

/// 对应 native.ts winClose：走统一关闭流程（脏标记 → 原生确认对话框拦截）。
#[tauri::command]
pub(crate) fn tmd_win_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/// 对应 native.ts recentSync：启动全量同步最近列表（仅重建菜单）。
#[tauri::command]
pub(crate) fn tmd_recent_sync(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    entries: Vec<RecentEntry>,
) {
    shell.recent_sync(&app, entries);
}

/// 对应 native.ts recentAdd：新增/打开 → 镜像列表去重置顶 + 重建菜单
/// （系统最近文档注册无 Tauri 对应，spike 缺口）。
#[tauri::command]
pub(crate) fn tmd_recent_add(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    entry: RecentEntry,
) {
    shell.recent_add(&app, entry);
}

/// 对应 native.ts recentClear。
#[tauri::command]
pub(crate) fn tmd_recent_clear(app: tauri::AppHandle, shell: tauri::State<'_, ShellState>) {
    shell.recent_clear(&app);
}

/// 对应 native.ts recentRemove：单条移除。
#[tauri::command]
pub(crate) fn tmd_recent_remove(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    path: String,
) {
    shell.recent_remove(&app, &path);
}
