//! 应用菜单构建（electron/menu.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐：菜单文案取自渲染层下发的语言包（缺键回落中文默认）、
//! accelerator 优先用户自定义（syncShortcuts）回落内置默认、最近文件子菜单
//! （空列表为禁用占位项）、自动保存为 checkbox。
//!
//! spike 已知缺口（对齐 menu.cjs 的 role 项，后续补齐）：
//! - macOS appMenu（about/services/hide）与编辑/视图 role 子菜单未建
//!   （webview 原生响应 Cmd+C/V 等编辑快捷键，功能不受损，菜单 UI 缺失）
//! - 退出项固定用默认中文文案「退出 TMD」（labels 无 quit 键）
//!
//! 平台差异：菜单仅 macOS 实挂（系统菜单栏，见 shell.rs rebuild_menu 注释）；
//! Windows 挂原生菜单会闪菜单栏且偏离 Electron 观感（Electron 版隐藏菜单栏、
//! 快捷键走渲染层 keydown），故本文件的菜单构建在 Windows 下不参与接线
//! （is_safe_external_url / RecentEntry 等纯逻辑两侧共用）。
//!
//! @author chiangyang

// 菜单构建函数在 Windows 下不接线（见上方平台差异），保留实现待后续统一
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// 菜单文案默认值（中文兜底）：与 menu.cjs 的 DEFAULT_MENU_LABELS 逐键一致，
/// 另增 spike 专用的 quit 键。
pub(crate) const DEFAULT_MENU_LABELS: &[(&str, &str)] = &[
    ("file", "文件"),
    ("open", "打开"),
    ("openFolder", "打开文件夹"),
    ("openRecent", "打开最近文件"),
    ("recentEmpty", "（无最近文件）"),
    ("clearRecent", "清空最近文件"),
    ("save", "保存"),
    ("saveAs", "另存为"),
    ("newTab", "新标签页"),
    ("closeTab", "关闭标签页"),
    ("autosave", "自动保存到文件"),
    ("export", "导出"),
    ("exportHtml", "导出 HTML"),
    ("exportPdf", "打印 / 导出 PDF"),
    ("exportWord", "导出 Word"),
    ("exportLongimage", "导出长图"),
    ("exportEpub", "导出 ePub"),
    ("exportLatex", "导出 LaTeX"),
    ("format", "格式"),
    ("bold", "加粗"),
    ("italic", "斜体"),
    ("strike", "删除线"),
    ("inlineCode", "行内代码"),
    ("highlight", "高亮"),
    ("superscript", "上标"),
    ("subscript", "下标"),
    ("link", "链接…"),
    ("h1", "一级标题"),
    ("h2", "二级标题"),
    ("h3", "三级标题"),
    ("h4", "四级标题"),
    ("h5", "五级标题"),
    ("h6", "六级标题"),
    ("paragraph", "正文"),
    ("quote", "引用"),
    ("codeBlock", "代码块"),
    ("bulletList", "无序列表"),
    ("orderedList", "有序列表"),
    ("history", "历史版本"),
    ("settings", "设置…"),
    ("quit", "退出 TMD"),
];

/// 中文兜底文案表（渲染层语言包缺键时回落）
pub(crate) fn default_labels() -> HashMap<String, String> {
    DEFAULT_MENU_LABELS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// 菜单项 accelerator：优先用户自定义，否则默认值（与 accOf 一致）。
pub(crate) fn acc_of(shortcuts: &HashMap<String, String>, action: &str, fallback: &str) -> String {
    shortcuts
        .get(action)
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

/// 界面语言码 → Intl 排序区域（与 ipc-app.cjs 的 COLLATION_LOCALE 一致）：
/// 繁中必须落 zh-TW 才走注音/笔画序；未知语言码原样透传。
pub(crate) fn collation_locale(locale: &str) -> String {
    match locale {
        "zh-CN" => "zh-CN".into(),
        "zh-Hant" => "zh-TW".into(),
        "en" => "en".into(),
        other => other.to_string(),
    }
}

/// 外部链接协议白名单：仅 http/https/mailto（与 isSafeExternalUrl 一致）。
pub(crate) fn is_safe_external_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => matches!(parsed.scheme(), "http" | "https" | "mailto"),
        Err(_) => false,
    }
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct RecentEntry {
    pub path: String,
    pub name: String,
}

/// 构建产物：菜单本体 + 自动保存 checkbox 句柄（状态回读/外部同步用）。
pub(crate) struct BuiltMenu {
    pub menu: Menu<Wry>,
    pub autosave: CheckMenuItem<Wry>,
}

/// 创建菜单项；accelerator 解析失败时降级为无快捷键（不阻断整个菜单）。
fn make_item(
    app: &AppHandle,
    id: &str,
    text: String,
    accel: Option<String>,
) -> tauri::Result<MenuItem<Wry>> {
    if let Some(acc) = accel {
        if let Ok(item) = MenuItem::with_id(app, id, text.clone(), true, Some(acc.as_str())) {
            return Ok(item);
        }
    }
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

/// Box 动态条目列表 → with_items 需要的 &[&dyn] 形状。
fn item_refs(items: &[Box<dyn IsMenuItem<Wry>>]) -> Vec<&dyn IsMenuItem<Wry>> {
    items
        .iter()
        .map(|i| i.as_ref() as &dyn IsMenuItem<Wry>)
        .collect()
}

/// 构建应用菜单（纯转换：同一入参恒得同一结构，副作用由菜单事件分发承担）。
pub(crate) fn build_menu(
    app: &AppHandle,
    labels: &HashMap<String, String>,
    shortcuts: &HashMap<String, String>,
    recents: &[RecentEntry],
    autosave_enabled: bool,
) -> tauri::Result<BuiltMenu> {
    let l = |key: &str| -> String { labels.get(key).cloned().unwrap_or_else(|| key.to_string()) };

    // ---------- 打开最近文件子菜单 ----------
    let mut recent_items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    if recents.is_empty() {
        // 空列表为禁用占位项（与 JS 版一致）
        let disabled =
            MenuItem::with_id(app, "recent-empty", l("recentEmpty"), false, None::<&str>)?;
        recent_items.push(Box::new(disabled));
    } else {
        for entry in recents {
            recent_items.push(Box::new(make_item(
                app,
                &format!("recent::{}", entry.path),
                entry.name.clone(),
                None,
            )?));
        }
        recent_items.push(Box::new(PredefinedMenuItem::separator(app)?));
        recent_items.push(Box::new(make_item(
            app,
            "clear-recent",
            l("clearRecent"),
            None,
        )?));
    }
    let recent_submenu =
        Submenu::with_items(app, l("openRecent"), true, &item_refs(&recent_items))?;

    let autosave_item = CheckMenuItem::with_id(
        app,
        "autosave",
        l("autosave"),
        true,
        autosave_enabled,
        None::<&str>,
    )?;

    // ---------- 文件 ----------
    let file_items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(make_item(
            app,
            "open",
            l("open"),
            Some(acc_of(shortcuts, "open", "CmdOrCtrl+O")),
        )?),
        Box::new(make_item(
            app,
            "open-folder",
            l("openFolder"),
            Some(acc_of(shortcuts, "open-folder", "CmdOrCtrl+Shift+O")),
        )?),
        Box::new(recent_submenu),
        Box::new(make_item(
            app,
            "save",
            l("save"),
            Some(acc_of(shortcuts, "save", "CmdOrCtrl+S")),
        )?),
        Box::new(make_item(
            app,
            "save-as",
            l("saveAs"),
            Some(acc_of(shortcuts, "save-as", "CmdOrCtrl+Shift+S")),
        )?),
        // 历史版本：低频查阅，不绑快捷键（与 JS 版口径一致）
        Box::new(make_item(app, "history", l("history"), None)?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(make_item(
            app,
            "new-tab",
            l("newTab"),
            Some(acc_of(shortcuts, "new-tab", "CmdOrCtrl+T")),
        )?),
        Box::new(make_item(
            app,
            "close-tab",
            l("closeTab"),
            Some(acc_of(shortcuts, "close-tab", "CmdOrCtrl+W")),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(autosave_item.clone()),
        Box::new(PredefinedMenuItem::separator(app)?),
        // 设置面板 accelerator 走系统惯例，不进快捷键自定义表（与 JS 版口径一致）
        Box::new(make_item(
            app,
            "open-settings",
            l("settings"),
            Some("CmdOrCtrl+,".into()),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(make_item(
            app,
            "quit",
            l("quit"),
            Some("CmdOrCtrl+Q".into()),
        )?),
    ];
    let file_menu = Submenu::with_items(app, l("file"), true, &item_refs(&file_items))?;

    // ---------- 导出 ----------
    let export_items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(make_item(
            app,
            "export-html",
            l("exportHtml"),
            Some(acc_of(shortcuts, "export-html", "CmdOrCtrl+Shift+D")),
        )?),
        Box::new(make_item(
            app,
            "export-pdf",
            l("exportPdf"),
            Some(acc_of(shortcuts, "export-pdf", "CmdOrCtrl+Shift+P")),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
        // Word / 长图走离屏渲染（重任务不绑快捷键）；LaTeX 纯文本转换——口径同 JS 版
        Box::new(make_item(app, "export-word", l("exportWord"), None)?),
        Box::new(make_item(
            app,
            "export-longimage",
            l("exportLongimage"),
            None,
        )?),
        Box::new(make_item(app, "export-epub", l("exportEpub"), None)?),
        Box::new(make_item(app, "export-latex", l("exportLatex"), None)?),
        // spike 阶段 B 原型触发项（Rust 侧直接处理，不经渲染层）
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(make_item(
            app,
            "spike-pdf",
            "Spike: 全文档 PDF 导出".to_string(),
            None,
        )?),
        Box::new(make_item(
            app,
            "spike-snapshot",
            "Spike: 视口截图".to_string(),
            None,
        )?),
        Box::new(make_item(
            app,
            "spike-export-window-matrix",
            "Spike: 导窗形态矩阵".to_string(),
            None,
        )?),
    ];
    let export_menu = Submenu::with_items(app, l("export"), true, &item_refs(&export_items))?;

    // ---------- 格式 ----------
    let mut format_items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(make_item(
            app,
            "fmt-bold",
            l("bold"),
            Some(acc_of(shortcuts, "fmt-bold", "CmdOrCtrl+B")),
        )?),
        Box::new(make_item(
            app,
            "fmt-italic",
            l("italic"),
            Some(acc_of(shortcuts, "fmt-italic", "CmdOrCtrl+I")),
        )?),
        Box::new(make_item(app, "fmt-strike", l("strike"), None)?),
        Box::new(make_item(app, "fmt-code", l("inlineCode"), None)?),
        Box::new(make_item(
            app,
            "fmt-mark",
            l("highlight"),
            Some(acc_of(shortcuts, "fmt-mark", "CmdOrCtrl+Shift+H")),
        )?),
        Box::new(make_item(
            app,
            "fmt-sup",
            l("superscript"),
            Some(acc_of(shortcuts, "fmt-sup", "CmdOrCtrl+Shift+=")),
        )?),
        Box::new(make_item(
            app,
            "fmt-sub",
            l("subscript"),
            Some(acc_of(shortcuts, "fmt-sub", "CmdOrCtrl+Shift+-")),
        )?),
        Box::new(make_item(
            app,
            "fmt-link",
            l("link"),
            Some(acc_of(shortcuts, "fmt-link", "CmdOrCtrl+K")),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    for level in 1..=6 {
        format_items.push(Box::new(make_item(
            app,
            &format!("fmt-h{}", level),
            l(&format!("h{}", level)),
            Some(acc_of(
                shortcuts,
                &format!("fmt-h{}", level),
                &format!("CmdOrCtrl+{}", level),
            )),
        )?));
    }
    format_items.push(Box::new(make_item(
        app,
        "fmt-paragraph",
        l("paragraph"),
        Some(acc_of(shortcuts, "fmt-paragraph", "CmdOrCtrl+0")),
    )?));
    format_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    // mac 上 Cmd+Q 是退出应用，引用改用 Ctrl+Q（与 JS 版避让口径一致）
    let quote_acc = if cfg!(target_os = "macos") {
        "Ctrl+Q"
    } else {
        "CmdOrCtrl+Q"
    };
    format_items.push(Box::new(make_item(
        app,
        "fmt-quote",
        l("quote"),
        Some(acc_of(shortcuts, "fmt-quote", quote_acc)),
    )?));
    format_items.push(Box::new(make_item(
        app,
        "fmt-codeblock",
        l("codeBlock"),
        Some(acc_of(shortcuts, "fmt-codeblock", "CmdOrCtrl+Shift+K")),
    )?));
    format_items.push(Box::new(make_item(
        app,
        "fmt-bullet",
        l("bulletList"),
        Some(acc_of(shortcuts, "fmt-bullet", "CmdOrCtrl+Shift+8")),
    )?));
    format_items.push(Box::new(make_item(
        app,
        "fmt-ordered",
        l("orderedList"),
        Some(acc_of(shortcuts, "fmt-ordered", "CmdOrCtrl+Shift+9")),
    )?));
    let format_menu = Submenu::with_items(app, l("format"), true, &item_refs(&format_items))?;

    let menu = Menu::with_items(app, &[&file_menu, &export_menu, &format_menu])?;
    Ok(BuiltMenu {
        menu,
        autosave: autosave_item,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acc_of_prefers_custom_shortcut() {
        let mut shortcuts = HashMap::new();
        shortcuts.insert("open".to_string(), "CmdOrCtrl+Alt+O".to_string());
        assert_eq!(acc_of(&shortcuts, "open", "CmdOrCtrl+O"), "CmdOrCtrl+Alt+O");
        assert_eq!(acc_of(&shortcuts, "save", "CmdOrCtrl+S"), "CmdOrCtrl+S");
    }

    #[test]
    fn collation_locale_maps_hant_to_tw() {
        assert_eq!(collation_locale("zh-Hant"), "zh-TW");
        assert_eq!(collation_locale("zh-CN"), "zh-CN");
        assert_eq!(collation_locale("en"), "en");
        assert_eq!(collation_locale("fr"), "fr");
    }

    #[test]
    fn safe_external_url_whitelists_protocols() {
        assert!(is_safe_external_url("https://example.com/a"));
        assert!(is_safe_external_url("http://example.com"));
        assert!(is_safe_external_url("mailto:a@b.c"));
        assert!(!is_safe_external_url("file:///etc/passwd"));
        assert!(!is_safe_external_url("javascript:alert(1)"));
        assert!(!is_safe_external_url("not a url"));
    }

    #[test]
    fn default_labels_cover_menu_keys() {
        let labels = default_labels();
        for key in ["file", "export", "format", "autosave", "settings", "quit"] {
            assert!(labels.contains_key(key), "缺键: {}", key);
        }
    }
}
