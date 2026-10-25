//! 文件式主题（electron/themes.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐（JS 版保留服务 Electron 壳，改动需两处同步）：
//! - 目录 `<资产根>/.tmd/themes`（资产根 = tmdHome：默认用户主目录，
//!   TMD_HOME_DIR 可重定位；主题是用户资产，跨安装保留）
//! - 一个 *.css 文件 = 一个主题，文件名（去扩展名）即显示名
//! - 只扫一层；忽略隐藏文件与非 .css；读取只接受单层裸文件名（防路径穿越）
//! - 旧版迁移：`<home>/themes`（v0.1.0–v0.1.3 漏 .tmd 段的产物）补拷到新目录，
//!   只增不覆盖，处理后写 `.tmd/.themes-migrated` 标记避免复活已删主题
//! - 目录不存在返回空列表（不主动创建——创建只发生在用户显式打开时）
//!
//! spike 已知缺口：排序用字典序而非 localeCompare（CJK 排序缺口同 readDir）。
//!
//! @author chiangyang

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个主题文件大小上限（1MB，远超正常 CSS 体量，仅为兜底）
pub(crate) const THEME_MAX_SIZE: u64 = 1024 * 1024;
/// 迁移完成标记：存在即不再扫描旧目录，避免用户删除主题后被旧文件复活
const THEMES_MIGRATION_MARKER: &str = ".themes-migrated";
/// 示例主题的文件名（中文，文件名即主题显示名）
const SAMPLE_THEME_FILE: &str = "示例主题.css";

/// 主题目录绝对路径：`<home>/.tmd/themes`（始终保留 .tmd 段）
pub(crate) fn themes_dir(home: &Path) -> PathBuf {
    home.join(".tmd").join("themes")
}

/// 判断裸文件名是否为可收录的主题文件（防路径穿越的第一道校验）
pub(crate) fn is_theme_file_name(name: &str) -> bool {
    name.len() > 4 // 至少 1 字符主名 + 「.css」
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).as_deref() == Some(name)
        && name.to_lowercase().ends_with(".css")
}

/// 主题显示名：去掉 .css 扩展名（大小写不敏感）
#[allow(dead_code)] // 显示名工具保留对齐 JS API（当前渲染层自行截扩展名）
pub(crate) fn theme_display_name(file_name: &str) -> String {
    if file_name.to_lowercase().ends_with(".css") {
        file_name[..file_name.len() - 4].to_string()
    } else {
        file_name.to_string()
    }
}

/// 扫描主题目录（目录不存在/不可读 → 空数组，不主动创建）。
/// locale 传 shell::sort_key 的口径（zh-CN/zh-TW 拼音近似，见 shell.rs）。
pub(crate) fn list_theme_files(dir: &Path, locale: &str) -> Vec<ThemeFileEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut themes: Vec<ThemeFileEntry> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_theme_file_name(n))
        .map(|name| ThemeFileEntry { name })
        .collect();
    themes.sort_by(|a, b| crate::shell::sort_key(&a.name, locale).cmp(&crate::shell::sort_key(&b.name, locale)));
    themes
}

/// 读取主题文件内容（UTF-8）；文件名非法/不存在/超上限 → None
pub(crate) fn read_theme_file(dir: &Path, name: &str) -> Option<String> {
    if !is_theme_file_name(name) {
        return None;
    }
    let full = dir.join(name);
    // 二次防线：join 结果必须仍直接位于主题目录内
    if full.parent()? != std::path::absolute(dir).ok()?.as_path() {
        return None;
    }
    let stat = fs::metadata(&full).ok()?;
    if !stat.is_file() || stat.len() > THEME_MAX_SIZE {
        return None;
    }
    fs::read_to_string(&full).ok()
}

/// 首次打开主题文件夹时写入的示例主题（列出全部可覆盖变量，照抄改即可）
pub(crate) const SAMPLE_THEME_CSS: &str = r#"/**
 * TMD 自定义主题示例
 *
 * 规则：
 * 1. 本文件名去掉 .css 就是设置面板里显示的主题名（支持中文），重命名文件即改名
 * 2. 只需写想覆盖的变量，未列出的变量自动沿用内置值
 * 3. 浅色外观写在 :root 下；深色外观写在 html.dark 下（工具栏月亮按钮切换深浅）
 * 4. 除变量外也可写任意 CSS 选择器，本文件内容会原样注入应用
 * 5. 在外部编辑器修改并保存后，到设置面板点「刷新」即生效
 */

/* 浅色模式（默认） */
:root {
  --bg: #faf8f5;                     /* 界面与编辑区背景 */
  --fg: #333333;                     /* 正文文字 */
  --muted: #888888;                  /* 次要文字 */
  --border: #e5e0d8;                 /* 边框 / 分隔线 */
  --accent: #c17f59;                 /* 强调色（链接、选中态） */
  --code-bg: #f3efe8;                /* 行内代码背景 */
  --pre-bg: #f0ebe2;                /* 代码块背景 */
  --quote-bg: transparent;           /* 引用块背景 */
  --toolbar-bg: rgba(250, 248, 245, 0.85); /* 工具栏背景 */
  --error-fg: #d1242f;               /* 错误文字 */
  --error-bg: #fff1f0;               /* 错误背景 */
}

/* 深色模式（可选：整块删掉则深色下沿用内置深色变量） */
html.dark {
  --bg: #262320;
  --fg: #e0dbd3;
  --muted: #9a9388;
  --border: #44403a;
  --accent: #d49a6a;
  --code-bg: #33302b;
  --pre-bg: #2e2b27;
  --quote-bg: transparent;
  --toolbar-bg: rgba(38, 35, 32, 0.85);
  --error-fg: #f97583;
  --error-bg: #3a2426;
}
"#;

/// 确保主题目录存在；目录中尚无任何 .css 文件时写入示例主题
/// （wx 兜底：极端竞态下不覆盖已有文件）。删空后不会再写回。
pub(crate) fn ensure_themes_dir_with_sample(dir: &Path) -> std::io::Result<bool> {
    fs::create_dir_all(dir)?;
    let has_css = fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_type().map(|t| t.is_file()).unwrap_or(false)
                    && is_theme_file_name(&e.file_name().to_string_lossy())
            })
        })
        .unwrap_or(false);
    if has_css {
        return Ok(false);
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(SAMPLE_THEME_FILE))
        .and_then(|mut f| std::io::Write::write_all(&mut f, SAMPLE_THEME_CSS.as_bytes()))
        .map(|_| true)
}

/// 把旧版本误写到 `<home>/themes` 的 CSS 主题补拷到 `<home>/.tmd/themes`
/// （只增不覆盖；处理后写标记，之后不再扫描）。返回实际复制的主题文件数。
pub(crate) fn migrate_legacy_themes(home: &Path) -> usize {
    let legacy_dir = home.join("themes");
    let target_dir = themes_dir(home);
    if legacy_dir == target_dir {
        return 0;
    }
    let marker = home.join(".tmd").join(THEMES_MIGRATION_MARKER);
    if marker.exists() {
        return 0; // 已迁移过：不再扫描/补拷，避免复活用户已删除的主题
    }
    let Ok(entries) = fs::read_dir(&legacy_dir) else {
        return 0; // 无旧目录（绝大多数用户）：不做任何创建
    };
    let files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            is_theme_file_name(
                &p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )
        })
        .collect();
    if files.is_empty() {
        return 0;
    }
    if fs::create_dir_all(&target_dir).is_err() {
        return 0;
    }
    let mut copied = 0;
    for src in files {
        let Some(name) = src.file_name() else {
            continue;
        };
        // 目标已有同名主题时跳过而非覆盖（迁移失败不影响主题列表）
        if fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target_dir.join(&name))
            .and_then(|mut f| std::io::Write::write_all(&mut f, &fs::read(&src)?))
            .is_ok()
        {
            copied += 1;
        }
    }
    // 即使本次全部同名跳过也写标记：之后用户删除新目录主题时不再从旧目录补回
    let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let _ = fs::write(&marker, format!("{}\n", stamp));
    copied
}

#[derive(Serialize)]
pub(crate) struct ThemeFileEntry {
    pub name: String,
}

#[derive(Serialize)]
pub(crate) struct ThemeFileList {
    pub dir: String,
    pub themes: Vec<ThemeFileEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tmd-spike-themes-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn theme_file_name_rules() {
        assert!(is_theme_file_name("示例主题.css"));
        assert!(is_theme_file_name("dark.CSS")); // 大小写不敏感
        assert!(!is_theme_file_name(".hidden.css"));
        assert!(!is_theme_file_name("a/b.css"));
        assert!(!is_theme_file_name(".css")); // 空主名（len 4 不 > 4）
        assert!(!is_theme_file_name("style.scss"));
    }

    #[test]
    fn display_name_strips_ext() {
        assert_eq!(theme_display_name("示例主题.css"), "示例主题");
        assert_eq!(theme_display_name("Dark.CSS"), "Dark");
        assert_eq!(theme_display_name("plain"), "plain");
    }

    #[test]
    fn read_theme_blocks_traversal_and_oversize() {
        let home = temp_home("read");
        let dir = themes_dir(&home);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ok.css"), "body{}").unwrap();
        assert_eq!(read_theme_file(&dir, "ok.css").as_deref(), Some("body{}"));
        assert_eq!(read_theme_file(&dir, "../../etc/passwd"), None);
        assert_eq!(read_theme_file(&dir, "ghost.css"), None);
        // 超上限
        fs::write(dir.join("big.css"), "a".repeat(THEME_MAX_SIZE as usize + 1)).unwrap();
        assert_eq!(read_theme_file(&dir, "big.css"), None);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn list_themes_skips_non_css_and_hidden() {
        let home = temp_home("list");
        let dir = themes_dir(&home);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.css"), "").unwrap();
        fs::write(dir.join("a.css"), "").unwrap();
        fs::write(dir.join("a.scss"), "").unwrap();
        fs::write(dir.join(".x.css"), "").unwrap();
        let themes = list_theme_files(&dir, "");
        assert_eq!(
            themes.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["a.css", "b.css"]
        );
        // 目录不存在 → 空数组
        assert!(list_theme_files(&home.join("ghost"), "").is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn sample_theme_written_only_into_empty_dir() {
        let home = temp_home("sample");
        let dir = themes_dir(&home);
        let written = ensure_themes_dir_with_sample(&dir).unwrap();
        assert!(written);
        assert!(dir.join(SAMPLE_THEME_FILE).exists());
        // 第二次：已有 .css → 不写
        assert!(!ensure_themes_dir_with_sample(&dir).unwrap());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn legacy_migration_copies_once_with_marker() {
        let home = temp_home("migrate");
        let legacy = home.join("themes");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("old.css"), "body{}").unwrap();
        fs::write(legacy.join("keep.css"), "h1{}").unwrap();
        let copied = migrate_legacy_themes(&home);
        assert_eq!(copied, 2);
        let target = themes_dir(&home);
        assert!(target.join("old.css").exists());
        assert!(home.join(".tmd").join(THEMES_MIGRATION_MARKER).exists());
        // 用户删除新目录主题后：标记仍在，不再从旧目录补回
        fs::remove_file(target.join("old.css")).unwrap();
        assert_eq!(migrate_legacy_themes(&home), 0);
        assert!(!target.join("old.css").exists());
        // 无旧目录 → 0 且不建目录
        let home2 = temp_home("migrate2");
        assert_eq!(migrate_legacy_themes(&home2), 0);
        assert!(!home2.join(".tmd").join("themes").exists());
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(home2);
    }

    #[test]
    fn migration_never_overwrites_newer_theme() {
        let home = temp_home("migrate3");
        let legacy = home.join("themes");
        let target = themes_dir(&home);
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("a.css"), "旧版本").unwrap();
        fs::write(target.join("a.css"), "用户当前版本").unwrap();
        let copied = migrate_legacy_themes(&home);
        assert_eq!(copied, 0);
        assert_eq!(
            fs::read_to_string(target.join("a.css")).unwrap(),
            "用户当前版本"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn themes_dir_layout_has_tmd_segment() {
        // 防回归：始终保留 .tmd 段（v0.1.0–v0.1.3 的漏段教训）
        assert!(themes_dir(Path::new("/home/x")).ends_with(".tmd/themes"));
        assert_eq!(themes_dir(Path::new("/home/x")), tmd_home_check());
    }

    fn tmd_home_check() -> PathBuf {
        Path::new("/home/x").join(".tmd").join("themes")
    }
}
