//! 主题文件系统、导出资源与本地日志（electron/themes.cjs + export-assets.cjs + logger.cjs 对应）。
//!
//! @author chiangyang

use serde_json::Value;
use std::sync::Arc;

use crate::export_assets::{self, ExportAssets};
use crate::history;
use crate::logger::{self, Logger};
use crate::shell::ShellState;
use crate::themes::{self, ThemeFileList};

// ---------- 主题文件系统与导出资源（electron/themes.cjs + export-assets.cjs 对应） ----------

/// 对应 native.ts listThemes：先跑旧目录迁移，返回 { dir, themes }。
#[tauri::command]
pub(crate) fn tmd_list_themes(shell_state: tauri::State<'_, ShellState>) -> ThemeFileList {
    let home = history::tmd_home();
    themes::migrate_legacy_themes(&home);
    let dir = themes::themes_dir(&home);
    let locale = shell_state.sort_locale();
    ThemeFileList {
        dir: dir.to_string_lossy().into_owned(),
        themes: themes::list_theme_files(&dir, &locale),
    }
}

/// 对应 native.ts readTheme：按裸文件名读取主题 CSS（防路径穿越，失败 null）。
#[tauri::command]
pub(crate) fn tmd_read_theme(name: String) -> Option<String> {
    themes::read_theme_file(&themes::themes_dir(&history::tmd_home()), &name)
}

/// 对应 native.ts openThemesDir：目录不存在则创建 + 空目录写示例主题，再打开。
#[tauri::command]
pub(crate) fn tmd_open_themes_dir() -> bool {
    let dir = themes::themes_dir(&history::tmd_home());
    if themes::ensure_themes_dir_with_sample(&dir).is_err() {
        return false;
    }
    opener::open(&dir).is_ok()
}

/// 对应 native.ts getExportAssets：离线导出资源（KaTeX 字体已内联 data URI），
/// 缺失时 null（渲染层回退 CDN）。
#[tauri::command]
pub(crate) fn tmd_get_export_assets() -> Option<ExportAssets> {
    export_assets::load_export_assets()
}

// ---------- 本地日志（electron/logger.cjs + ipc-files 对应） ----------

/// 对应 native.ts reportError：渲染层未捕获异常写入本地日志
/// （级别固定 error、来源固定 renderer，客户端不可指定）。
#[tauri::command]
pub(crate) fn tmd_report_error(logger: tauri::State<'_, Arc<Logger>>, entry: Value) {
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
pub(crate) fn tmd_open_logs_dir() -> bool {
    let dir = logger::logs_dir(&history::tmd_home());
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    opener::open(&dir).is_ok()
}
