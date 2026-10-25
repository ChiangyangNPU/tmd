//! TMD Tauri 壳层（spike 通过后的正式迁移起点，双壳共存——Electron 壳不受影响）。
//!
//! 架构：`window.tmdAPI` 契约（src/native.ts）由本壳经 initialization_script
//! 注入 Proxy 门面实现；纯逻辑按 electron/ 的模块边界下沉到独立文件
//! （text_file.rs / search.rs / wikilinks.rs），与 JS 版逐语义对齐并可单测。
//!
//! 已实现通道：readFile / saveFile / readDir / openFile / openFolder /
//! saveFileAs / exportAs / searchFiles / wikiScan / watchFiles / watchDirs /
//! listHistory / readHistory（+ 事件订阅 onFileChanged / onDirsChanged）。
//! 未实现通道 no-op + console.warn，不阻塞启动（渲染层的 `!native` 降级判断不受影响）。
//! identifier 使用 com.chiangyang.tmd.spike，userData 与 Electron 版完全隔离。

mod history;
mod search;
mod text_file;
mod watcher;
mod wikilinks;

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use history::{FileHistory, HistoryEntry};
use search::SearchResult;
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
fn tmd_read_dir(dir_path: String) -> Result<DirListing, String> {
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
    children.sort_by(|a, b| a.name.cmp(&b.name));
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

/// native.ts saveFileAs / exportAs 的返回形状 { path, name }
#[derive(Serialize)]
struct SaveAsResult {
    path: String,
    name: String,
}

fn save_as_result_of(path: String) -> SaveAsResult {
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
fn dialog_path_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
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
    let Some(picked) = picked else { return Ok(None) };
    let Some(path) = dialog_path_string(picked) else { return Ok(None) };
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
    let Some(picked) = picked else { return Ok(None) };
    let Some(path) = dialog_path_string(picked) else { return Ok(None) };
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
    let Some(picked) = picked else { return Ok(None) };
    let Some(path) = dialog_path_string(picked) else { return Ok(None) };
    fs::write(&path, options.content).map_err(|e| format!("{}: {}", path, e))?;
    Ok(Some(save_as_result_of(path)))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatchState::new(app.handle().clone()));
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("TMD (tauri spike)")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 600.0)
                .initialization_script(TMD_API_SHIM)
                .build()?;
            Ok(())
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
            tmd_open_file,
            tmd_open_folder,
            tmd_save_file_as,
            tmd_export_as
        ])
        .run(tauri::generate_context!())
        .expect("TMD (tauri spike) 启动失败");
}
