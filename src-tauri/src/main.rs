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

mod ai;
mod ai_client;
mod ai_config;
mod export_assets;
// macOS 专属导出原语（objc2 直调 WKWebView）与离屏导出服务；其余平台
// exporter 切到同名命令的占位实现（exporter_stub.rs），命令面保持一致
#[cfg(target_os = "macos")]
mod export_native;
#[cfg(target_os = "macos")]
mod export_probe;
#[cfg(target_os = "macos")]
mod exporter;
#[cfg(not(target_os = "macos"))]
#[path = "exporter_stub.rs"]
mod exporter;
mod fsops;
mod history;
mod logger;
mod menu;
mod search;
mod shell;
mod text_file;
mod themes;
mod watcher;
mod wikilinks;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use history::{FileHistory, HistoryEntry};
use logger::Logger;
use menu::RecentEntry;
use search::SearchResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shell::{ShellState, WinStateTracker};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use text_file::{default_encoding_str, file_name_of, read_file_at, SaveMeta, TextFileData};
use watcher::WatchState;
use wikilinks::WikiScanResult;

/// 注入到每个页面加载前的渲染层 shim：定义与 electron/preload.cjs 同名的
/// `window.tmdAPI`。已实现通道走 Tauri invoke；其余通道 no-op + 一次性告警。
const TMD_API_SHIM: &str = r#"
(function () {
  if (window.tmdAPI) return
  var core = window.__TAURI__ && window.__TAURI__.core
  if (!core || !core.invoke) return
  var invoke = core.invoke
  var impl = {
    isNative: true,
    readFile: function (filePath) { return invoke('tmd_read_file', { filePath: filePath }) },
    saveFile: function (filePath, content, meta) {
      return invoke('tmd_save_file', { filePath: filePath, content: content, meta: meta || null })
    },
    readDir: function (dirPath) { return invoke('tmd_read_dir', { dirPath: dirPath }) },
    openFile: function () { return invoke('tmd_open_file') },
    openFolder: function () { return invoke('tmd_open_folder') },
    saveFileAs: function (content, defaultName, meta) {
      return invoke('tmd_save_file_as', { content: content, defaultName: defaultName || null, meta: meta || null })
    },
    exportAs: function (options) { return invoke('tmd_export_as', { options: options }) },
    searchFiles: function (roots, query) { return invoke('tmd_search_files', { roots: roots, query: query }) },
    wikiScan: function (roots) { return invoke('tmd_wiki_scan', { roots: roots }) },
    watchFiles: function (paths) { invoke('tmd_watch_files', { paths: paths }) },
    watchDirs: function (paths) { invoke('tmd_watch_dirs', { paths: paths }) },
    onFileChanged: function (cb) { tmdOn('tmd-file-changed', cb) },
    onDirsChanged: function (cb) { tmdOn('tmd-dirs-changed', cb) },
    listHistory: function (filePath) { return invoke('tmd_list_history', { filePath: filePath }) },
    readHistory: function (filePath, id) { return invoke('tmd_read_history', { filePath: filePath, id: id }) },
    setLocaleInfo: function (info) { invoke('tmd_set_locale_info', { labels: (info && info.labels) || {}, locale: (info && info.locale) || '' }) },
    syncShortcuts: function (shortcuts) { invoke('tmd_sync_shortcuts', { shortcuts: shortcuts || {} }) },
    setAutosaveEnabled: function (enabled) { invoke('tmd_set_autosave_enabled', { enabled: !!enabled }) },
    setDirty: function (dirty) { invoke('tmd_set_dirty', { dirty: !!dirty }) },
    setThemeSource: function (isDark) { return invoke('tmd_set_theme_source', { isDark: !!isDark }) },
    winMinimize: function () { invoke('tmd_win_minimize') },
    winMaximizeToggle: function () { invoke('tmd_win_max_toggle') },
    winClose: function () { invoke('tmd_win_close') },
    recentSync: function (entries) { invoke('tmd_recent_sync', { entries: entries || [] }) },
    recentAdd: function (entry) { invoke('tmd_recent_add', { entry: entry }) },
    recentClear: function () { invoke('tmd_recent_clear') },
    recentRemove: function (path) { invoke('tmd_recent_remove', { path: path }) },
    ready: function () { invoke('tmd_ready') },
    onOpenPath: function (cb) { tmdOn('tmd-open-path', cb) },
    onMenu: function (cb) { tmdOn('tmd-menu', cb) },
    onRecentOpen: function (cb) { tmdOn('tmd-recent-open', cb) },
    onAutosave: function (cb) { tmdOn('tmd-autosave', cb) },
    onWindowMaximize: function (cb) { tmdOn('tmd-win-max-changed', cb) },
    getAiConfig: function () { return invoke('tmd_ai_get_config') },
    saveAiConfig: function (patch) { return invoke('tmd_ai_save_config', { patch: patch || {} }) },
    testAiConnection: function (overrides) { return invoke('tmd_ai_test', { overrides: overrides || {} }) },
    chatAi: function (requestId, messages) { return invoke('tmd_ai_chat', { requestId: requestId, messages: messages }) },
    abortAi: function (requestId) { return invoke('tmd_ai_abort', { requestId: requestId }) },
    embedAiTexts: function (texts) { return invoke('tmd_ai_embed', { texts: texts }) },
    onAiStream: function (cb) { tmdOn('tmd-ai-stream', cb) },
    reportError: function (entry) { invoke('tmd_report_error', { entry: entry }) },
    openLogsDir: function () { return invoke('tmd_open_logs_dir') },
    saveImage: function (options) { return invoke('tmd_save_image', { dir: options.dir, name: options.name, base64: options.base64 }) },
    openExternal: function (url) { return invoke('tmd_open_external', { url: url }) },
    openLocalFile: function (filePath) { return invoke('tmd_open_local_file', { filePath: filePath }) },
    revealInFolder: function (targetPath) { return invoke('tmd_reveal_in_folder', { targetPath: targetPath }) },
    deletePath: function (targetPath) { return invoke('tmd_delete_path', { targetPath: targetPath }) },
    createFile: function (dirPath, name) { return invoke('tmd_create_file', { dirPath: dirPath, name: name }) },
    createDir: function (dirPath, name) { return invoke('tmd_create_dir', { dirPath: dirPath, name: name }) },
    renamePath: function (oldPath, name) { return invoke('tmd_rename_path', { oldPath: oldPath, name: name }) },
    listThemes: function () { return invoke('tmd_list_themes') },
    readTheme: function (name) { return invoke('tmd_read_theme', { name: name }) },
    openThemesDir: function () { return invoke('tmd_open_themes_dir') },
    getExportAssets: function () { return invoke('tmd_get_export_assets') },
    exportRun: function (options) { return invoke('tmd_export_run', { options: options }) },
    print: function (name, options) { return invoke('tmd_print', { name: name || null, options: options || null }) },
  }
  var listened = {}
  function tmdOn(event, cb) {
    if (!listened[event]) {
      listened[event] = []
      window.__TAURI__.event.listen(event, function (e) {
        var cbs = listened[event]
        for (var i = 0; i < cbs.length; i++) cbs[i](e.payload)
      })
    }
    listened[event].push(cb)
  }
  window.tmdAPI = new Proxy(impl, {
    get: function (target, prop) {
      if (prop in target) return target[prop]
      return function () {
        console.warn('[tmd-tauri-spike] 通道未实现（no-op）:', String(prop))
      }
    },
  })
  // 自绘标题栏拖拽区：Electron 用 CSS -webkit-app-region（02-toolbar.css），
  // WebView2 / WKWebView 不解析该属性，这里按同款选择器语义复刻——
  // .toolbar / .toolbar-left 为拖拽区，.toolbar button / .toolbar .word-count 豁免；
  // 与 02-toolbar.css 双侧同步维护（同 wikilinks 的两侧同构约定）。
  function dragHit(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.matches('.toolbar button, .toolbar .word-count')) return false
      if (n.matches('.toolbar, .toolbar-left')) return true
    }
    return false
  }
  document.addEventListener('mousedown', function (e) {
    // 左键且非双击按下时拖动窗口；双击交给 dblclick
    if (e.button === 0 && e.detail === 1 && dragHit(e.target)) invoke('plugin:window|start_dragging')
  })
  // Win/Linux：双击工具栏空白 = 最大化/还原（Electron 由 hidden 标题栏系统行为提供，
  // mac 双击行为跟随系统设置，这里不接管）
  document.addEventListener('dblclick', function (e) {
    if (document.documentElement.classList.contains('win') && dragHit(e.target)) invoke('tmd_win_max_toggle')
  })
})()
"#;

/// 对应 native.ts readFile → TextFileData（含保存回写所需的编码元信息）。
#[tauri::command]
fn tmd_read_file(file_path: String) -> Result<TextFileData, String> {
    read_file_at(file_path)
}

/// 对应 native.ts saveFile（meta 缺省按 UTF-8 无 BOM 写回）。
/// 保存事务三步有序（评估 §3.2）：写前快照旧内容 → 写盘 → 监视指纹登记，
/// 全部在同一 Rust 调用内完成；快照失败静默，绝不阻断保存。
#[tauri::command]
fn tmd_save_file(
    file_path: String,
    content: String,
    meta: Option<SaveMeta>,
    watch: tauri::State<'_, WatchState>,
) -> Result<bool, String> {
    let (encoding, bom) = meta
        .map(|m| (m.encoding, m.bom))
        .unwrap_or_else(|| (default_encoding_str().to_string(), false));
    let bytes = text_file::encode(&content, &encoding, bom);
    history::snapshot_before_write(&history::history_root(), &file_path);
    fs::write(&file_path, bytes).map_err(|e| format!("{}: {}", file_path, e))?;
    watch.note_write(&file_path, &content);
    Ok(true)
}

#[derive(Serialize)]
struct FileEntryRust {
    name: String,
    path: String,
    /// 目录恒有（可为空数组，渲染层以 `!!children` 判别目录）；文件不序列化该字段
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileEntryRust>>,
}

#[derive(Serialize)]
struct DirListing {
    path: String,
    name: String,
    children: Vec<FileEntryRust>,
}

/// 对应 native.ts readDir → { path, name, children }。
/// 过滤与 Electron readDir 对齐：跳过点开头条目，文件只收 .md / .markdown / .txt；
/// 目录 children 返回空数组（渲染层懒加载时会对子目录再次 readDir）。
#[tauri::command]
fn tmd_read_dir(
    dir_path: String,
    shell_state: tauri::State<'_, ShellState>,
) -> Result<DirListing, String> {
    let mut children: Vec<FileEntryRust> = Vec::new();
    let entries = fs::read_dir(&dir_path).map_err(|e| format!("{}: {}", dir_path, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        if is_dir {
            children.push(FileEntryRust {
                name,
                path,
                children: Some(Vec::new()),
            });
        } else if name.ends_with(".md") || name.ends_with(".markdown") || name.ends_with(".txt") {
            children.push(FileEntryRust {
                name,
                path,
                children: None,
            });
        }
    }
    // 文件树排序跟随界面语言（zh-CN 拼音序近似，见 shell::sort_key）
    let locale = shell_state.sort_locale();
    children
        .sort_by(|a, b| shell::sort_key(&a.name, &locale).cmp(&shell::sort_key(&b.name, &locale)));
    let name = file_name_of(&dir_path);
    Ok(DirListing {
        path: dir_path,
        name,
        children,
    })
}

/// 对应 native.ts searchFiles → SearchResult。
/// 上限（文件数/命中数）与截断语义在 search.rs 与 JS 版逐项对齐。
#[tauri::command]
fn tmd_search_files(roots: Vec<String>, query: String) -> SearchResult {
    let start = std::time::Instant::now();
    let needle = query.to_lowercase();
    let (files, _) = search::collect_search_files(&roots, search::SEARCH_MAX_FILES);
    let (matches, file_count, truncated) =
        search::search_in_files(&files, &needle, search::SEARCH_MAX_MATCHES);
    SearchResult {
        matches,
        file_count,
        scanned_files: files.len(),
        truncated,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

/// 对应 native.ts wikiScan → WikiScanResult。
/// 收集/解析语义与 wikilinks.rs（JS 版 wikilinks.cjs）逐项对齐。
#[tauri::command]
fn tmd_wiki_scan(roots: Vec<String>) -> WikiScanResult {
    wikilinks::scan_wiki_links(&roots)
}

/// 对应 native.ts watchFiles：全量同步「打开文件集合」（差量增删 watcher）。
#[tauri::command]
fn tmd_watch_files(paths: Vec<String>, watch: tauri::State<'_, WatchState>) {
    watch.sync_files(paths);
}

/// 对应 native.ts watchDirs：全量同步「已加载目录集合」（差量增删 watcher）。
#[tauri::command]
fn tmd_watch_dirs(paths: Vec<String>, watch: tauri::State<'_, WatchState>) {
    watch.sync_dirs(paths);
}

/// 对应 native.ts listHistory：某源文件的快照清单（最新在前），无历史 null。
#[tauri::command]
fn tmd_list_history(file_path: String) -> Option<FileHistory> {
    history::list_snapshots(&history::history_root(), &file_path)
}

/// 对应 native.ts readHistory：读取单条快照正文，id 非法/缺失/超大 null。
#[tauri::command]
fn tmd_read_history(file_path: String, id: String) -> Option<HistoryEntry> {
    history::read_snapshot(&history::history_root(), &file_path, &id)
}

// ---------- 应用级状态同步与窗口控制（electron/ipc-app.cjs 的 Rust 对应） ----------

/// 对应 native.ts setLocaleInfo：下发语言包 → 重建菜单；返回映射后的排序区域。
#[tauri::command]
fn tmd_set_locale_info(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    labels: HashMap<String, String>,
    locale: String,
) -> String {
    shell.set_locale_info(&app, labels, &locale)
}

/// 对应 native.ts syncShortcuts：快捷键配置 → 菜单 accelerator 重建。
#[tauri::command]
fn tmd_sync_shortcuts(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    shortcuts: HashMap<String, String>,
) {
    shell.sync_shortcuts(&app, shortcuts);
}

/// 对应 native.ts setAutosaveEnabled：设置面板同步开关（保持菜单勾选一致）。
#[tauri::command]
fn tmd_set_autosave_enabled(shell: tauri::State<'_, ShellState>, enabled: bool) {
    shell.set_autosave_enabled(enabled);
}

/// 对应 native.ts ready：渲染层就绪信号，冲刷排队中的待打开文件
/// （并恢复/聚焦窗口——对应 main.cjs 的 flushPendingOpenPaths）。
#[tauri::command]
fn tmd_ready(app: tauri::AppHandle, pending: tauri::State<'_, PendingOpenPaths>) {
    pending.ready.store(true, Ordering::SeqCst);
    flush_pending_open_paths(&app);
}

/// 对应 native.ts setDirty：渲染层同步未保存状态（关闭确认用）。
#[tauri::command]
fn tmd_set_dirty(shell: tauri::State<'_, ShellState>, dirty: bool) {
    shell.set_dirty(dirty);
}

/// 对应 native.ts setThemeSource：窗口深浅主题随渲染层切换（handle + invoke，
/// 壳层切换完成后才返回，渲染层随后再翻页面——与 Electron 口径一致）。
/// spike 简化：不做 shell-state 持久化，重启回落系统默认。
#[tauri::command]
fn tmd_set_theme_source(window: tauri::WebviewWindow, is_dark: bool) -> Result<(), String> {
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
fn tmd_win_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

/// 对应 native.ts winMaximizeToggle：最大化 / 还原切换。
#[tauri::command]
fn tmd_win_max_toggle(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

/// 对应 native.ts winClose：走统一关闭流程（脏标记 → 原生确认对话框拦截）。
#[tauri::command]
fn tmd_win_close(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/// 对应 native.ts recentSync：启动全量同步最近列表（仅重建菜单）。
#[tauri::command]
fn tmd_recent_sync(
    app: tauri::AppHandle,
    shell: tauri::State<'_, ShellState>,
    entries: Vec<RecentEntry>,
) {
    shell.recent_sync(&app, entries);
}

/// 对应 native.ts recentAdd：新增/打开 → 镜像列表去重置顶 + 重建菜单
/// （系统最近文档注册无 Tauri 对应，spike 缺口）。
#[tauri::command]
fn tmd_recent_add(app: tauri::AppHandle, shell: tauri::State<'_, ShellState>, entry: RecentEntry) {
    shell.recent_add(&app, entry);
}

/// 对应 native.ts recentClear。
#[tauri::command]
fn tmd_recent_clear(app: tauri::AppHandle, shell: tauri::State<'_, ShellState>) {
    shell.recent_clear(&app);
}

/// 对应 native.ts recentRemove：单条移除。
#[tauri::command]
fn tmd_recent_remove(app: tauri::AppHandle, shell: tauri::State<'_, ShellState>, path: String) {
    shell.recent_remove(&app, &path);
}

// ---------- 文件管理与系统打开（electron/ipc-app.cjs + ipc-files.cjs 对应） ----------

/// 对应 native.ts saveImage：粘贴图片落盘到文档同目录 assets/（base64 解码）。
/// 入参白名单：name 必须是非隐藏裸文件名（拒绝路径分隔与 .. 穿越）。
#[tauri::command]
fn tmd_save_image(dir: String, name: String, base64: String) -> Result<Value, String> {
    let bare = Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .is_some_and(|n| n == name);
    if dir.is_empty() || name.is_empty() || base64.is_empty() || !bare || name.starts_with('.') {
        return Err("saveImage: 非法入参".into());
    }
    let bytes = STANDARD
        .decode(&base64)
        .map_err(|_| "saveImage: base64 解码失败".to_string())?;
    let assets_dir = Path::new(&dir).join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    fs::write(assets_dir.join(&name), bytes).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "name": name }))
}

/// 对应 native.ts openExternal：外链打开（协议白名单 http/https/mailto）。
#[tauri::command]
fn tmd_open_external(url: String) -> bool {
    if !menu::is_safe_external_url(&url) {
        return false;
    }
    opener::open(&url).is_ok()
}

/// 对应 native.ts openLocalFile：系统默认应用打开本地文件，空串为成功。
#[tauri::command]
fn tmd_open_local_file(file_path: String) -> String {
    if file_path.is_empty() {
        return "invalid path".into();
    }
    opener::open(&file_path)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default()
}

/// 对应 native.ts revealInFolder：系统文件管理器中显示该文件/文件夹。
#[tauri::command]
fn tmd_reveal_in_folder(target_path: String) -> bool {
    !target_path.is_empty() && opener::reveal(&target_path).is_ok()
}

/// 对应 native.ts deletePath：移入系统回收站（确认由渲染层承担）。
#[tauri::command]
fn tmd_delete_path(target_path: String) -> bool {
    if target_path.is_empty() {
        return false;
    }
    trash::delete(&target_path).is_ok()
}

/// 对应 native.ts createFile：目录下新建 Markdown 文件（自动补 .md，wx 不覆盖）。
#[tauri::command]
fn tmd_create_file(dir_path: String, name: String) -> Result<Value, String> {
    let is_win = cfg!(target_os = "windows");
    let safe = fsops::sanitize_file_name(&name, is_win).ok_or("invalid file name")?;
    let target = fsops::child_path(&dir_path, &fsops::ensure_markdown_ext(&safe), is_win)
        .ok_or("invalid file name")?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
}

/// 对应 native.ts createDir：目录下新建文件夹（已存在时报错）。
#[tauri::command]
fn tmd_create_dir(dir_path: String, name: String) -> Result<Value, String> {
    let is_win = cfg!(target_os = "windows");
    let target = fsops::child_path(&dir_path, &name, is_win).ok_or("invalid folder name")?;
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
}

/// 对应 native.ts renamePath：同目录内重命名（重名/非法名 reject）。
#[tauri::command]
fn tmd_rename_path(old_path: String, name: String) -> Result<Value, String> {
    if old_path.is_empty() {
        return Err("invalid path".into());
    }
    let is_win = cfg!(target_os = "windows");
    let target = fsops::child_path(
        &Path::new(&old_path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        &name,
        is_win,
    )
    .ok_or("invalid rename target")?;
    if target == old_path {
        return Err("invalid rename target".into());
    }
    fs::rename(&old_path, &target).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
}

// ---------- 主题文件系统与导出资源（electron/themes.cjs + export-assets.cjs 对应） ----------

/// 对应 native.ts listThemes：先跑旧目录迁移，返回 { dir, themes }。
#[tauri::command]
fn tmd_list_themes(shell_state: tauri::State<'_, ShellState>) -> themes::ThemeFileList {
    let home = history::tmd_home();
    themes::migrate_legacy_themes(&home);
    let dir = themes::themes_dir(&home);
    let locale = shell_state.sort_locale();
    themes::ThemeFileList {
        dir: dir.to_string_lossy().into_owned(),
        themes: themes::list_theme_files(&dir, &locale),
    }
}

/// 对应 native.ts readTheme：按裸文件名读取主题 CSS（防路径穿越，失败 null）。
#[tauri::command]
fn tmd_read_theme(name: String) -> Option<String> {
    themes::read_theme_file(&themes::themes_dir(&history::tmd_home()), &name)
}

/// 对应 native.ts openThemesDir：目录不存在则创建 + 空目录写示例主题，再打开。
#[tauri::command]
fn tmd_open_themes_dir() -> bool {
    let dir = themes::themes_dir(&history::tmd_home());
    if themes::ensure_themes_dir_with_sample(&dir).is_err() {
        return false;
    }
    opener::open(&dir).is_ok()
}

/// 对应 native.ts getExportAssets：离线导出资源（KaTeX 字体已内联 data URI），
/// 缺失时 null（渲染层回退 CDN）。
#[tauri::command]
fn tmd_get_export_assets() -> Option<export_assets::ExportAssets> {
    export_assets::load_export_assets()
}

// ---------- 本地日志（electron/logger.cjs + ipc-files 对应） ----------

/// 对应 native.ts reportError：渲染层未捕获异常写入本地日志
/// （级别固定 error、来源固定 renderer，客户端不可指定）。
#[tauri::command]
fn tmd_report_error(logger: tauri::State<'_, Arc<Logger>>, entry: Value) {
    if let Some(report) = logger::normalize_renderer_report(&entry) {
        logger.log(
            "error",
            "renderer",
            &report.message,
            report.stack.as_deref(),
            &logger::LogMeta {
                filename: report.filename.as_deref(),
                lineno: report.lineno,
                colno: report.colno,
                ..Default::default()
            },
        );
    }
}

/// 对应 native.ts openLogsDir：系统文件管理器打开日志目录（不存在则创建）。
#[tauri::command]
fn tmd_open_logs_dir() -> bool {
    let dir = logger::logs_dir(&history::tmd_home());
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    opener::open(&dir).is_ok()
}

/// native.ts saveFileAs / exportAs 的返回形状 { path, name }
#[derive(Serialize)]
pub(crate) struct SaveAsResult {
    path: String,
    name: String,
}

pub(crate) fn save_as_result_of(path: String) -> SaveAsResult {
    let name = file_name_of(&path);
    SaveAsResult { path, name }
}

/// native.ts exportAs 的入参 { content, defaultName, filters }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAsOptions {
    content: String,
    default_name: String,
    #[serde(default)]
    filters: Vec<ExportFilter>,
}

/// tauri-plugin-dialog 的 FilePath → 字符串路径。
pub(crate) fn dialog_path_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
    match p {
        tauri_plugin_dialog::FilePath::Path(pb) => Some(pb.to_string_lossy().into_owned()),
        tauri_plugin_dialog::FilePath::Url(u) => Some(u.to_string()),
    }
}

/// 对应 native.ts openFile：文件对话框 → 读取（编码元信息齐全）。
#[tauri::command]
async fn tmd_open_file(app: tauri::AppHandle) -> Result<Option<TextFileData>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown / 文本", &["md", "markdown", "txt"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let Some(path) = dialog_path_string(picked) else {
        return Ok(None);
    };
    read_file_at(path).map(Some)
}

/// 对应 native.ts openFolder：文件夹对话框 → 绝对路径。
#[tauri::command]
async fn tmd_open_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(dialog_path_string))
}

/// 对应 native.ts saveFileAs：保存对话框 → 按原编码写回（含自身写入指纹登记）。
#[tauri::command]
async fn tmd_save_file_as(
    app: tauri::AppHandle,
    content: String,
    default_name: Option<String>,
    meta: Option<SaveMeta>,
    watch: tauri::State<'_, WatchState>,
) -> Result<Option<SaveAsResult>, String> {
    let mut dialog = app.dialog().file();
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(name);
    }
    let picked = dialog.blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let Some(path) = dialog_path_string(picked) else {
        return Ok(None);
    };
    let (encoding, bom) = meta
        .map(|m| (m.encoding, m.bom))
        .unwrap_or_else(|| (default_encoding_str().to_string(), false));
    let bytes = text_file::encode(&content, &encoding, bom);
    history::snapshot_before_write(&history::history_root(), &path);
    fs::write(&path, bytes).map_err(|e| format!("{}: {}", path, e))?;
    watch.note_write(&path, &content);
    Ok(Some(save_as_result_of(path)))
}

/// 对应 native.ts exportAs：导出落盘（导出产物恒为 UTF-8 文本）。
#[tauri::command]
async fn tmd_export_as(
    app: tauri::AppHandle,
    options: ExportAsOptions,
) -> Result<Option<SaveAsResult>, String> {
    let mut dialog = app.dialog().file().set_file_name(options.default_name);
    for filter in &options.filters {
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &exts);
    }
    let picked = dialog.blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let Some(path) = dialog_path_string(picked) else {
        return Ok(None);
    };
    fs::write(&path, options.content).map_err(|e| format!("{}: {}", path, e))?;
    Ok(Some(save_as_result_of(path)))
}

fn main() {
    let app = tauri::Builder::default()
        // 单实例锁：二次启动的 argv 转交主实例（官方要求该插件最先注册）
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for path in argv {
                queue_open_path(app, path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
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
            // AI 配置存 userData（identifier 隔离，与 Electron 安装版互不相通）
            let data_dir = app.path().app_data_dir().expect("userData 目录不可用");
            app.manage(ai::AiState::new(data_dir.join("ai-config.json")));
            // 壳层持久化：主题与窗口几何在首帧前恢复（与 Electron createWindow 前恢复同口径）
            let shell_file = data_dir.join("shell-state.json");
            let persisted = shell::read_shell_state(&shell_file);
            app.manage(WinStateTracker::new(shell_file.clone()));
            let restored_theme = match persisted.get("themeSource").and_then(Value::as_str) {
                Some("dark") => Some(tauri::Theme::Dark),
                Some("light") => Some(tauri::Theme::Light),
                _ => None,
            };
            let display_rects = shell::monitor_rects(&app.available_monitors().unwrap_or_default());
            let restored = shell::restore_win_state(&persisted, &display_rects);
            // 启动即用中文默认文案建菜单；渲染层就绪后经 setLocaleInfo 按语言重建
            app.state::<ShellState>().rebuild_menu(app.handle());
            let mut builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("TMD (tauri spike)")
                    .min_inner_size(940.0, 600.0)
                    .initialization_script(TMD_API_SHIM);
            if let Some(theme) = restored_theme {
                builder = builder.theme(Some(theme));
            }
            // 标题栏对齐 Electron 壳观感（electron/main.cjs:374-376）：
            // Win/Linux titleBarStyle 'hidden' → decorations(false) 全自绘（拖拽区与
            // 最大化/关闭由 shim 的拖拽处理 + html.win 自绘按钮承担）；
            // macOS 'hiddenInset' → Overlay 隐藏标题条 + 红绿灯 (16,16) 对齐
            // trafficLightPosition，需 tauri.conf.json 开 macOSPrivateApi（内容延伸到标题栏下）
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.decorations(false);
            }
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
                let _ = window.maximize();
            }
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
                            export_native::capture_full_pdf(&window, w, h).and_then(|bytes| {
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
                "clear-recent" => {
                    // 清空动作交渲染层执行（localStorage 是唯一权威），口径同 JS 版
                    let _ = app.emit("tmd-menu", "clear-recent".to_string());
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
                                    let bytes = export_native::capture_full_pdf(&window, w, h)?;
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
                    // 落盘线程醒来时代数未变才写）
                    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                        let tracker = window.app_handle().state::<WinStateTracker>();
                        tracker.record(
                            pos.x,
                            pos.y,
                            size.width as f64,
                            size.height as f64,
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
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // 未保存关闭确认：原生对话框拦截（渲染层 window.confirm 不可靠，
                    // Electron 同款原因）。破坏性按钮不做默认，默认落在「取消」。
                    let shell = window.app_handle().state::<ShellState>();
                    if !shell.is_dirty() {
                        return;
                    }
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        let abandon = app
                            .dialog()
                            .message("关闭前会丢失未保存的内容。")
                            .title("有未保存的修改")
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "放弃修改并关闭".to_string(),
                                "取消".to_string(),
                            ))
                            .blocking_show();
                        if abandon {
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
            tmd_read_file,
            tmd_save_file,
            tmd_read_dir,
            tmd_search_files,
            tmd_wiki_scan,
            tmd_watch_files,
            tmd_watch_dirs,
            tmd_list_history,
            tmd_read_history,
            tmd_set_locale_info,
            tmd_sync_shortcuts,
            tmd_set_autosave_enabled,
            tmd_set_dirty,
            tmd_set_theme_source,
            tmd_win_minimize,
            tmd_win_max_toggle,
            tmd_win_close,
            tmd_recent_sync,
            tmd_recent_add,
            tmd_recent_clear,
            tmd_recent_remove,
            ai::tmd_ai_get_config,
            ai::tmd_ai_save_config,
            ai::tmd_ai_test,
            ai::tmd_ai_chat,
            ai::tmd_ai_abort,
            ai::tmd_ai_embed,
            tmd_save_image,
            tmd_open_external,
            tmd_open_local_file,
            tmd_reveal_in_folder,
            tmd_delete_path,
            tmd_create_file,
            tmd_create_dir,
            tmd_rename_path,
            tmd_list_themes,
            tmd_read_theme,
            tmd_open_themes_dir,
            tmd_get_export_assets,
            exporter::tmd_export_run,
            exporter::tmd_exporter_done,
            exporter::tmd_exporter_capture,
            exporter::tmd_exporter_read_image,
            exporter::tmd_print,
            tmd_report_error,
            tmd_ready,
            tmd_open_logs_dir,
            tmd_open_file,
            tmd_open_folder,
            tmd_save_file_as,
            tmd_export_as
        ])
        .build(tauri::generate_context!())
        .expect("TMD (tauri spike) 启动失败");
    app.run(|_app, _event| {
        // 文件关联：Finder 双击 / 系统打开方式。
        // RunEvent::Opened 仅存在于 Apple 平台；Windows 的关联启动与二次双击
        // 都经单实例插件的 second-instance argv 转交（上方注册处已处理）。
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        handle_opened_event(_app, &_event);
    });
}

/// macOS open-file / iOS 打开事件：路径入待打开队列
/// （Windows 不派发此事件，编译期排除，见 run 回调注释）
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn handle_opened_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::Opened { urls } = event {
        for url in urls {
            let path = url
                .to_file_path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| url.to_string());
            queue_open_path(app, path);
        }
    }
}

/// 待打开文件队列：渲染层 ready 前入队（文件关联早于渲染层就绪），
/// ready 命令或二次启动转交时冲刷（对应 main.cjs 的 pendingOpenPaths）。
/// ready 标志防止「渲染层监听注册前 emit 进真空」——Electron 版
/// queueOpenPath 的 `if (!app.isReady()) return` 同款语义。
#[derive(Default)]
struct PendingOpenPaths {
    queue: std::sync::Mutex<Vec<String>>,
    ready: AtomicBool,
}

/// 可打开扩展名（与渲染层白名单同口径）
fn is_openable_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

/// 入队；仅当渲染层已 ready 才冲刷，否则等 ready 命令补发
fn queue_open_path(app: &tauri::AppHandle, path: String) {
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
fn flush_pending_open_paths(app: &tauri::AppHandle) {
    let paths = {
        let pending = app.state::<PendingOpenPaths>();
        let mut g = pending.queue.lock().expect("pending open 锁中毒");
        std::mem::take(&mut *g)
    };
    for path in paths {
        let _ = app.emit("tmd-open-path", path);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 最大化状态去重标记（Resized 事件高频，只在状态翻转时推送）
struct MaximizedFlag(AtomicBool);
