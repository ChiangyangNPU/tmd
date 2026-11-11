//! 导出落盘（native.ts exportAs 对应）。
//!
//! @author chiangyang

use serde::Deserialize;
use std::fs;
use tauri_plugin_dialog::DialogExt;

use crate::commands::files::{dialog_path_string, save_as_result_of, SaveAsResult};
use crate::error::CmdError;

/// native.ts exportAs 的入参 { content, defaultName, filters }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportAsOptions {
    content: String,
    default_name: String,
    #[serde(default)]
    filters: Vec<ExportFilter>,
}

/// 对应 native.ts exportAs：导出落盘（导出产物恒为 UTF-8 文本）。
#[tauri::command]
pub(crate) async fn tmd_export_as(
    app: tauri::AppHandle,
    options: ExportAsOptions,
) -> Result<Option<SaveAsResult>, CmdError> {
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
    fs::write(&path, options.content).map_err(|e| CmdError::io(format!("{}: {}", path, e)))?;
    Ok(Some(save_as_result_of(path)))
}
