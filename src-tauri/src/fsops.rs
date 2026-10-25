//! 侧边栏文件管理的纯函数集合（electron/fsops.cjs 的 Rust 移植）。
//!
//! 渲染层传来的名称不可信：拒绝空名、路径分隔符、目录穿越片段、控制字符
//! 与隐藏文件；拼装路径后二次校验 basename 未被名称变换破坏，杜绝越出
//! 目标目录。与 JS 版逐项对齐（JS 版保留服务 Electron 壳，改动需两处同步）。

use std::path::Path;

/// 名称长度上限（与常见文件系统上限一致）
pub(crate) const MAX_NAME_LENGTH: usize = 255;

/// 清洗用户输入的文件/文件夹名：非法返回 None，合法返回 trim 后的名称。
/// 拒绝：空串、纯点（. / ..）、含路径分隔符（/ \\）、含控制字符、
/// 以点开头（隐藏文件）、超长。Windows 平台额外拒绝：保留字符
/// （< > : " | ? *）、尾部点、保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）。
/// macOS 的半角冒号刻意放行（POSIX 合法，仅 Finder 有显示怪癖）——与 JS 版
/// 的跨平台决策一致，勿顺手提为全平台拒绝。
pub(crate) fn sanitize_file_name(name: &str, is_win: bool) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NAME_LENGTH {
        return None;
    }
    if trimmed.starts_with('.') {
        return None;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return None;
    }
    if trimmed == "." || trimmed == ".." {
        return None;
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    if is_win {
        if trimmed.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return None;
        }
        if trimmed.ends_with('.') {
            return None;
        }
        if is_win32_reserved_name(trimmed) {
            return None;
        }
    }
    Some(trimmed.to_string())
}

/// Windows 保留设备名（大小写不敏感，裸名或带扩展名均保留，如 CON、CON.md）。
/// 前置条件：尾部点已被拒绝（Win32 规则），故 dot 后必有内容或无 dot。
fn is_win32_reserved_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    matches!(
        stem,
        "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6"
        | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6"
        | "lpt7" | "lpt8" | "lpt9"
    )
}

/// 目录 + 已清洗名称 → 子路径；二次防线：join 后 basename 必须与名称一致
/// （防止任何未预料的名称变换把路径挪出目标目录）。
pub(crate) fn child_path(dir: &str, name: &str, is_win: bool) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let safe = sanitize_file_name(name, is_win)?;
    let joined = Path::new(dir).join(&safe);
    let base = joined.file_name()?.to_string_lossy().into_owned();
    if base == safe {
        Some(joined.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// 新建文件的落盘名：无 .md 扩展名时补上（Markdown 编辑器的新建语义）。
pub(crate) fn ensure_markdown_ext(name: &str) -> String {
    if name.to_lowercase().ends_with(".md") {
        name.to_string()
    } else {
        format!("{}.md", name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_unsafe_names() {
        assert_eq!(sanitize_file_name("  笔记  ", false).as_deref(), Some("笔记"));
        assert_eq!(sanitize_file_name("", false), None);
        assert_eq!(sanitize_file_name("   ", false), None);
        assert_eq!(sanitize_file_name(".hidden", false), None);
        assert_eq!(sanitize_file_name("a/b.md", false), None);
        assert_eq!(sanitize_file_name("a\\b.md", false), None);
        assert_eq!(sanitize_file_name(".", false), None);
        assert_eq!(sanitize_file_name("..", false), None);
        assert_eq!(sanitize_file_name("a\u{0000}b", false), None);
        assert_eq!(sanitize_file_name("a\u{001f}b", false), None);
        assert_eq!(sanitize_file_name(&"长".repeat(256), false), None);
    }

    #[test]
    fn sanitize_windows_specific_rules() {
        assert_eq!(sanitize_file_name("a:b.md", true), None); // 冒号 Win 非法
        assert_eq!(sanitize_file_name("a:b.md", false).as_deref(), Some("a:b.md")); // mac 放行
        assert_eq!(sanitize_file_name("name.", true), None); // 尾部点
        assert_eq!(sanitize_file_name("name.", false).as_deref(), Some("name."));
        assert_eq!(sanitize_file_name("con.md", true), None); // 保留设备名
        assert_eq!(sanitize_file_name("CON", true), None);
        assert_eq!(sanitize_file_name("lpt9.md", true), None);
        assert_eq!(sanitize_file_name("conx.md", true).as_deref(), Some("conx.md")); // 非保留
        assert_eq!(sanitize_file_name("a<b", true), None);
    }

    #[test]
    fn child_path_second_line_defense() {
        assert_eq!(
            child_path("/tmp/notes", "新文件.md", false).as_deref(),
            Some("/tmp/notes/新文件.md")
        );
        assert_eq!(child_path("/tmp/notes", "../escape.md", false), None);
        assert_eq!(child_path("", "a.md", false), None);
    }

    #[test]
    fn markdown_ext_appended_when_missing() {
        assert_eq!(ensure_markdown_ext("笔记"), "笔记.md");
        assert_eq!(ensure_markdown_ext("笔记.MD"), "笔记.MD"); // 已有（大小写不敏感）
        assert_eq!(ensure_markdown_ext("note.txt.md"), "note.txt.md");
    }
}
