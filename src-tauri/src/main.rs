//! TMD Tauri spike 壳层。
//!
//! 目标不是功能对等，而是用最小代码验证迁移评估（docs/Tauri迁移评估.md）的三个前提：
//! 1. WKWebView 能原样加载 dist 渲染层（ProseMirror 编辑器 + Mermaid/KaTeX 实时渲染）
//! 2. `window.tmdAPI` 契约可由 Tauri 侧同名实现——经 initialization_script 注入
//!    Proxy 门面，`src/native.ts` 与渲染层 46 个调用点零改动
//! 3. 真实 IPC 派发：readFile / saveFile / readDir 三条通道走 Rust 命令，
//!    其中编码检测/写回直接用 encoding_rs 落地（对应 electron/text-file.cjs 的
//!    Rust 化原型，即迁移评估 §3.2「编码读写」一节）
//!
//! 未实现的通道在渲染层调用时以 console.warn 提示通道名并按 no-op 处理，
//! 不阻塞启动；菜单 / 推送类通道（onMenu 等）在 spike 中无主进程来源，no-op 即符合预期。
//! identifier 使用 com.chiangyang.tmd.spike，userData 与已安装的 Electron 版完全隔离。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextFileData {
    path: String,
    name: String,
    content: String,
    encoding: &'static str,
    bom: bool,
    line_ending: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMeta {
    #[serde(default = "default_encoding")]
    encoding: String,
    #[serde(default)]
    bom: bool,
    /// 契约字段（native.ts TextFileMeta）：换行已含在 content 里，写回无需处理，
    /// 保留反序列化以锁住通道入参形状
    #[serde(default = "default_line_ending")]
    #[allow(dead_code)]
    line_ending: String,
}

fn default_encoding() -> String {
    "utf-8".into()
}

fn default_line_ending() -> String {
    "lf".into()
}

/// 解码启发式与 electron/text-file.cjs 对齐：BOM 优先（UTF-8 / UTF-16LE/BE），
/// 无 BOM 时 UTF-8 合法则按 UTF-8，否则 GBK 兜底（spike 未做无 BOM UTF-16 启发式）。
fn decode(bytes: &[u8]) -> (&'static str, bool, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return ("utf-8", true, text.into_owned());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return ("utf-16le", true, text.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return ("utf-16be", true, text.into_owned());
    }
    let (text, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return ("utf-8", false, text.into_owned());
    }
    let (text, _, _) = encoding_rs::GBK.decode(bytes);
    ("gbk", false, text.into_owned())
}

/// 按原编码与 BOM 写回。GBK 无法映射的字符由 encoding_rs 产出数字字符引用
/// （浏览器同款行为）；text-file.cjs 走 iconv-lite 时是替换字符——差异在
/// 迁移评估验收时再对齐，spike 不处理。
fn encode(text: &str, encoding: &str, bom: bool) -> Vec<u8> {
    let (bytes, _, _) = match encoding {
        "gbk" => encoding_rs::GBK.encode(text),
        "utf-16le" => encoding_rs::UTF_16LE.encode(text),
        "utf-16be" => encoding_rs::UTF_16BE.encode(text),
        _ => encoding_rs::UTF_8.encode(text),
    };
    let mut out = Vec::with_capacity(bytes.len() + 3);
    match (bom, encoding) {
        (true, "utf-8") => out.extend_from_slice(&[0xEF, 0xBB, 0xBF]),
        (true, "utf-16le") => out.extend_from_slice(&[0xFF, 0xFE]),
        (true, "utf-16be") => out.extend_from_slice(&[0xFE, 0xFF]),
        _ => {}
    }
    out.extend_from_slice(&bytes);
    out
}

fn file_name_of(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 对应 native.ts readFile → TextFileData（含保存回写所需的编码元信息）。
#[tauri::command]
fn tmd_read_file(file_path: String) -> Result<TextFileData, String> {
    read_file_at(file_path)
}

fn read_file_at(file_path: String) -> Result<TextFileData, String> {
    let bytes = fs::read(&file_path).map_err(|e| format!("{}: {}", file_path, e))?;
    if !Path::new(&file_path).is_file() {
        return Err(format!("not a regular file: {}", file_path));
    }
    let (encoding, bom, content) = decode(&bytes);
    let line_ending = if content.contains("\r\n") { "crlf" } else { "lf" };
    let name = file_name_of(&file_path);
    Ok(TextFileData {
        path: file_path,
        name,
        content,
        encoding,
        bom,
        line_ending,
    })
}

/// 对应 native.ts saveFile（meta 缺省按 UTF-8 无 BOM 写回）。
#[tauri::command]
fn tmd_save_file(file_path: String, content: String, meta: Option<SaveMeta>) -> Result<bool, String> {
    let (encoding, bom) = meta
        .map(|m| (m.encoding, m.bom))
        .unwrap_or_else(|| (default_encoding(), false));
    let bytes = encode(&content, &encoding, bom);
    fs::write(&file_path, bytes).map_err(|e| format!("{}: {}", file_path, e))?;
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

/// 对应 native.ts saveFileAs：保存对话框 → 按原编码写回。
#[tauri::command]
async fn tmd_save_file_as(
    app: tauri::AppHandle,
    content: String,
    default_name: Option<String>,
    meta: Option<SaveMeta>,
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
        .unwrap_or_else(|| (default_encoding(), false));
    let bytes = encode(&content, &encoding, bom);
    fs::write(&path, bytes).map_err(|e| format!("{}: {}", path, e))?;
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
            tmd_open_file,
            tmd_open_folder,
            tmd_save_file_as,
            tmd_export_as
        ])
        .run(tauri::generate_context!())
        .expect("TMD (tauri spike) 启动失败");
}
