//! 文件读写、目录浏览、文件管理与系统打开（electron/ipc-app.cjs + ipc-files.cjs 对应）。
//!
//! @author chiangyang

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

use crate::error::CmdError;
use crate::exporter;
use crate::fsops;
use crate::history::{self, FileHistory, HistoryEntry};
use crate::menu;
use crate::search::{self, SearchResult};
use crate::shell::{self, ShellState};
use crate::text_file::{
    self, default_encoding_str, file_name_of, read_file_at, SaveMeta, TextFileData,
};
use crate::watcher::WatchState;
use crate::wikilinks::{self, WikiScanResult};

/// 对应 native.ts readFile → TextFileData（含保存回写所需的编码元信息）。
#[tauri::command]
pub(crate) fn tmd_read_file(file_path: String) -> Result<TextFileData, CmdError> {
    read_file_at(file_path)
}

/// 对应 native.ts saveFile（meta 缺省按 UTF-8 无 BOM 写回）。
/// 保存事务三步有序（评估 §3.2）：写前快照旧内容 → 写盘 → 监视指纹登记，
/// 全部在同一 Rust 调用内完成；快照失败静默，绝不阻断保存。
#[tauri::command]
pub(crate) fn tmd_save_file(
    file_path: String,
    content: String,
    meta: Option<SaveMeta>,
    watch: tauri::State<'_, WatchState>,
) -> Result<bool, CmdError> {
    let (encoding, bom) = meta
        .map(|m| (m.encoding, m.bom))
        .unwrap_or_else(|| (default_encoding_str().to_string(), false));
    let bytes = text_file::encode(&content, &encoding, bom);
    history::snapshot_before_write(&history::history_root(), &file_path);
    fs::write(&file_path, bytes).map_err(|e| CmdError::io(format!("{}: {}", file_path, e)))?;
    watch.note_write(&file_path, &content);
    Ok(true)
}

#[derive(Serialize)]
pub(crate) struct FileEntryRust {
    name: String,
    path: String,
    /// 目录恒有（可为空数组，渲染层以 `!!children` 判别目录）；文件不序列化该字段
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileEntryRust>>,
}

#[derive(Serialize)]
pub(crate) struct DirListing {
    path: String,
    name: String,
    children: Vec<FileEntryRust>,
}

/// 对应 native.ts readDir → { path, name, children }。
/// 过滤与 Electron readDir 对齐：跳过点开头条目，文件只收 .md / .markdown / .txt；
/// 目录 children 返回空数组（渲染层懒加载时会对子目录再次 readDir）。
#[tauri::command]
pub(crate) fn tmd_read_dir(
    dir_path: String,
    shell_state: tauri::State<'_, ShellState>,
) -> Result<DirListing, CmdError> {
    let mut children: Vec<FileEntryRust> = Vec::new();
    let entries =
        fs::read_dir(&dir_path).map_err(|e| CmdError::io(format!("{}: {}", dir_path, e)))?;
    for entry in entries {
        let entry = entry.map_err(|e| CmdError::io(e.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path().to_string_lossy().into_owned();
        let is_dir = entry
            .file_type()
            .map_err(|e| CmdError::io(e.to_string()))?
            .is_dir();
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
pub(crate) fn tmd_search_files(roots: Vec<String>, query: String) -> SearchResult {
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
pub(crate) fn tmd_wiki_scan(roots: Vec<String>) -> WikiScanResult {
    wikilinks::scan_wiki_links(&roots)
}

/// 对应 native.ts watchFiles：全量同步「打开文件集合」（差量增删 watcher）。
#[tauri::command]
pub(crate) fn tmd_watch_files(paths: Vec<String>, watch: tauri::State<'_, WatchState>) {
    watch.sync_files(paths);
}

/// 对应 native.ts watchDirs：全量同步「已加载目录集合」（差量增删 watcher）。
#[tauri::command]
pub(crate) fn tmd_watch_dirs(paths: Vec<String>, watch: tauri::State<'_, WatchState>) {
    watch.sync_dirs(paths);
}

/// 对应 native.ts listHistory：某源文件的快照清单（最新在前），无历史 null。
#[tauri::command]
pub(crate) fn tmd_list_history(file_path: String) -> Option<FileHistory> {
    history::list_snapshots(&history::history_root(), &file_path)
}

/// 对应 native.ts readHistory：读取单条快照正文，id 非法/缺失/超大 null。
#[tauri::command]
pub(crate) fn tmd_read_history(file_path: String, id: String) -> Option<HistoryEntry> {
    history::read_snapshot(&history::history_root(), &file_path, &id)
}

// ---------- 文件管理与系统打开（electron/ipc-app.cjs + ipc-files.cjs 对应） ----------

/// 对应 native.ts saveImage：粘贴图片落盘到文档同目录 assets/（base64 解码）。
/// 入参白名单：name 必须是非隐藏裸文件名（拒绝路径分隔与 .. 穿越）。
#[tauri::command]
pub(crate) fn tmd_save_image(dir: String, name: String, base64: String) -> Result<Value, CmdError> {
    let bare = Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .is_some_and(|n| n == name);
    if dir.is_empty() || name.is_empty() || base64.is_empty() || !bare || name.starts_with('.') {
        return Err(CmdError::invalid("saveImage: 非法入参"));
    }
    let bytes = STANDARD
        .decode(&base64)
        .map_err(|_| CmdError::invalid("saveImage: base64 解码失败"))?;
    let assets_dir = Path::new(&dir).join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| CmdError::io(e.to_string()))?;
    fs::write(assets_dir.join(&name), bytes).map_err(|e| CmdError::io(e.to_string()))?;
    Ok(serde_json::json!({ "name": name }))
}

/// 对应 native.ts openExternal：外链打开（协议白名单 http/https/mailto）。
#[tauri::command]
pub(crate) fn tmd_open_external(url: String) -> bool {
    if !menu::is_safe_external_url(&url) {
        return false;
    }
    opener::open(&url).is_ok()
}

/// 对应 native.ts readDroppedFile（Tauri 独有）：拖入图片按路径读字节转 base64，
/// 供渲染层构造 File 对象复用粘贴图片插入链。白名单扩展名 + 32MB 上限
/// （与导出图片本地化 read_image_as_data_uri 同口径），非法/超限返回 null。
#[tauri::command]
pub(crate) fn tmd_read_dropped_file(file_path: String) -> Result<Option<Value>, CmdError> {
    let Some(mime) = exporter::image_mime_of(&file_path) else {
        return Ok(None);
    };
    let Ok(meta) = fs::metadata(&file_path) else {
        return Ok(None);
    };
    if !meta.is_file() || meta.len() > exporter::MAX_IMAGE_BYTES {
        return Ok(None);
    }
    let Ok(bytes) = fs::read(&file_path) else {
        return Ok(None);
    };
    let name = Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(serde_json::json!({
        "name": name,
        "mime": mime,
        "base64": STANDARD.encode(bytes),
    })))
}

/// 对应 native.ts openLocalFile：系统默认应用打开本地文件，空串为成功。
#[tauri::command]
pub(crate) fn tmd_open_local_file(file_path: String) -> String {
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
pub(crate) fn tmd_reveal_in_folder(target_path: String) -> bool {
    !target_path.is_empty() && opener::reveal(&target_path).is_ok()
}

/// 对应 native.ts deletePath：移入系统回收站（确认由渲染层承担）。
#[tauri::command]
pub(crate) fn tmd_delete_path(target_path: String) -> bool {
    if target_path.is_empty() {
        return false;
    }
    trash::delete(&target_path).is_ok()
}

/// 对应 native.ts createFile：目录下新建 Markdown 文件（自动补 .md，wx 不覆盖）。
#[tauri::command]
pub(crate) fn tmd_create_file(dir_path: String, name: String) -> Result<Value, CmdError> {
    let is_win = cfg!(target_os = "windows");
    let safe =
        fsops::sanitize_file_name(&name, is_win).ok_or(CmdError::invalid("invalid file name"))?;
    let target = fsops::child_path(&dir_path, &fsops::ensure_markdown_ext(&safe), is_win)
        .ok_or(CmdError::invalid("invalid file name"))?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| CmdError::io(e.to_string()))?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
}

/// 对应 native.ts createDir：目录下新建文件夹（已存在时报错）。
#[tauri::command]
pub(crate) fn tmd_create_dir(dir_path: String, name: String) -> Result<Value, CmdError> {
    let is_win = cfg!(target_os = "windows");
    let target = fsops::child_path(&dir_path, &name, is_win)
        .ok_or(CmdError::invalid("invalid folder name"))?;
    fs::create_dir(&target).map_err(|e| CmdError::io(e.to_string()))?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
}

/// 对应 native.ts renamePath：同目录内重命名（重名/非法名 reject）。
#[tauri::command]
pub(crate) fn tmd_rename_path(old_path: String, name: String) -> Result<Value, CmdError> {
    if old_path.is_empty() {
        return Err(CmdError::invalid("invalid path"));
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
    .ok_or(CmdError::invalid("invalid rename target"))?;
    if target == old_path {
        return Err(CmdError::invalid("invalid rename target"));
    }
    fs::rename(&old_path, &target).map_err(|e| CmdError::io(e.to_string()))?;
    Ok(serde_json::json!({ "path": target, "name": file_name_of(&target) }))
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

/// tauri-plugin-dialog 的 FilePath → 字符串路径。
pub(crate) fn dialog_path_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
    match p {
        tauri_plugin_dialog::FilePath::Path(pb) => Some(pb.to_string_lossy().into_owned()),
        tauri_plugin_dialog::FilePath::Url(u) => Some(u.to_string()),
    }
}

/// 对应 native.ts openFile：文件对话框 → 读取（编码元信息齐全）。
#[tauri::command]
pub(crate) async fn tmd_open_file(app: tauri::AppHandle) -> Result<Option<TextFileData>, CmdError> {
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
pub(crate) async fn tmd_open_folder(app: tauri::AppHandle) -> Result<Option<String>, CmdError> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(dialog_path_string))
}

/// 对应 native.ts saveFileAs：保存对话框 → 按原编码写回（含自身写入指纹登记）。
#[tauri::command]
pub(crate) async fn tmd_save_file_as(
    app: tauri::AppHandle,
    content: String,
    default_name: Option<String>,
    meta: Option<SaveMeta>,
    watch: tauri::State<'_, WatchState>,
) -> Result<Option<SaveAsResult>, CmdError> {
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
    fs::write(&path, bytes).map_err(|e| CmdError::io(format!("{}: {}", path, e)))?;
    watch.note_write(&path, &content);
    Ok(Some(save_as_result_of(path)))
}
