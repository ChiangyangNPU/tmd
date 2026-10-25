//! 跨文件全文搜索（electron/search.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐的语义（改动需两处同步，JS 版在 master 仍服务于 Electron 壳）：
//! - BFS 收集：跳过点开头条目与 SEARCH_SKIP_DIRS（17 项），扩展名白名单
//! - 三重上限：单文件 2MB / 文件数 5000 / 命中行 500
//! - 匹配口径：大小写不敏感、按行汇总（一行至多一条命中）、
//!   occurrence 为该行首个匹配在文件内的序号（渲染层 findMatches 定位协议）
//! - 二进制嗅探：前 4096 字符含 NUL 跳过
//!
//! spike 简化：目录遍历顺序执行（JS 为并发 8 的分批——不改变产出顺序，
//! 仅吞吐差异；正式迁移如需更快可用 rayon 并行读盘）。
//!
//! @author chiangyang

use crate::text_file::{decode, file_name_of};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::sync::OnceLock;

/// 搜索时跳过的目录名（依赖 / 版本库 / 构建产物），与 search.cjs 一致。
const SEARCH_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "release",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    "__pycache__",
    ".idea",
    ".vscode",
    "coverage",
    "vendor",
];

/// 单文件大小上限（字节）
pub(crate) const SEARCH_MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// 单次搜索扫描的文件数上限
pub(crate) const SEARCH_MAX_FILES: usize = 5000;
/// 单次搜索返回的命中行数上限
pub(crate) const SEARCH_MAX_MATCHES: usize = 500;
/// 预览行文本的最大长度（超出截断）
const SEARCH_PREVIEW_LEN: usize = 200;

fn search_ext_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // 与 search.cjs 的 SEARCH_EXT_RE 逐项一致（case-insensitive）
        regex::Regex::new(
            r"(?i)\.(md|markdown|mdx|txt|text|json|ya?ml|toml|ini|csv|log|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|bat|ps1|sql|tex)$",
        )
        .expect("搜索扩展名正则编译失败")
    })
}

fn skip_dirs() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| SEARCH_SKIP_DIRS.iter().copied().collect())
}

/// 广度优先收集根目录下可搜索的文本文件 → (files, truncated)。
pub(crate) fn collect_search_files(roots: &[String], limit: usize) -> (Vec<String>, bool) {
    let mut files: Vec<String> = Vec::new();
    let mut queue: VecDeque<String> = roots.iter().cloned().collect();
    let mut truncated = false;
    while let Some(dir) = queue.pop_front() {
        if files.len() >= limit {
            truncated = true;
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            // 权限不足或目录已删除：跳过
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let full = entry.path().to_string_lossy().into_owned();
            if ft.is_dir() {
                if !skip_dirs().contains(name.as_str()) {
                    queue.push_back(full);
                }
            } else if ft.is_file() && search_ext_re().is_match(&name) {
                if files.len() < limit {
                    files.push(full);
                } else {
                    truncated = true;
                }
            }
        }
    }
    (files, truncated)
}

/// 预览截断：超长取前 max 个字符并补省略号（与 JS 的 UTF-16 口径在 BMP 内一致）。
fn preview(line: &str, max: usize) -> String {
    if line.chars().count() > max {
        let mut s: String = line.chars().take(max).collect();
        s.push('…');
        s
    } else {
        line.to_string()
    }
}

/// 在给定文件中逐行搜索（needle 须已转小写）→ (matches, fileCount, truncated)。
/// 匹配在「字符」空间进行：column/occurrence 与 JS 版的 UTF-16 口径在 BMP 内一致
/// （含中文的行不会因多字节编码产生列号漂移）。
pub(crate) fn search_in_files(
    files: &[String],
    needle: &str,
    limit: usize,
) -> (Vec<SearchMatch>, usize, bool) {
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut file_count = 0usize;
    let mut truncated = false;
    let needle_chars: Vec<char> = needle.chars().collect();
    for file in files {
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        let Ok(meta) = fs::metadata(file) else { continue };
        if meta.len() > SEARCH_MAX_FILE_SIZE {
            continue;
        }
        let Ok(bytes) = fs::read(file) else { continue };
        let (_, _, content) = decode(&bytes);
        // 二进制嗅探：前 4096 字符含 NUL 即视为非文本
        if content.chars().take(4096).any(|c| c == '\0') {
            continue;
        }
        let mut occurrence = 0usize;
        let mut hit_in_file = false;
        for (i, line) in content.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let lower: Vec<char> = line.to_lowercase().chars().collect();
            let Some(first) = find_sub(&lower, &needle_chars, 0) else {
                continue;
            };
            // 统计本行出现次数（含首匹配，与 JS 口径一致）：首匹配作为本行结果，
            // 其余仅推进 occurrence
            let mut count = 1usize;
            let mut cursor = first;
            while let Some(next) = find_sub(&lower, &needle_chars, cursor + needle_chars.len()) {
                count += 1;
                cursor = next;
            }
            if matches.len() >= limit {
                truncated = true;
                break;
            }
            occurrence += 1;
            matches.push(SearchMatch {
                path: file.clone(),
                name: file_name_of(file),
                line: i + 1,
                column: first + 1,
                occurrence,
                text: preview(line, SEARCH_PREVIEW_LEN),
            });
            hit_in_file = true;
            occurrence += count - 1;
        }
        if hit_in_file {
            file_count += 1;
        }
    }
    (matches, file_count, truncated)
}

/// 在字符序列中从 from 起查找子序列（无重叠跨界的朴素匹配，行级长度足够）。
fn find_sub(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for start in from..=haystack.len() - needle.len() {
        if haystack[start..start + needle.len()] == *needle {
            return Some(start);
        }
    }
    None
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub column: usize,
    pub occurrence: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub file_count: usize,
    pub scanned_files: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "tmd-spike-search-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn collect_skips_hidden_and_dependency_dirs_and_filters_extensions() {
        let root = temp_dir("collect");
        fs::create_dir_all(format!("{}/node_modules/pkg", root)).unwrap();
        fs::create_dir_all(format!("{}/.git", root)).unwrap();
        fs::create_dir_all(format!("{}/sub", root)).unwrap();
        fs::write(format!("{}/node_modules/pkg/a.md", root), "x").unwrap();
        fs::write(format!("{}/.git/config", root), "x").unwrap();
        fs::write(format!("{}/sub/note.md", root), "x").unwrap();
        fs::write(format!("{}/sub/data.bin", root), "x").unwrap();
        fs::write(format!("{}/root.md", root), "x").unwrap();
        let (files, truncated) = collect_search_files(&[root.clone()], SEARCH_MAX_FILES);
        assert!(!truncated);
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.ends_with("root.md")));
        assert!(files.iter().any(|f| f.ends_with("sub/note.md")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_reports_truncation_at_limit() {
        let root = temp_dir("limit");
        for i in 0..5 {
            fs::write(format!("{}/n{}.md", root, i), "x").unwrap();
        }
        let (files, truncated) = collect_search_files(&[root.clone()], 3);
        assert_eq!(files.len(), 3);
        assert!(truncated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_matches_line_column_occurrence_case_insensitive() {
        let root = temp_dir("match");
        let file = format!("{}/a.md", root);
        // 两行含关键词（首行 1 次、次行 2 次），occurrence 跨行累计
        fs::write(&file, "Rust 很棒\n学习 rust 与 RUST\n无匹配行\n").unwrap();
        let (matches, file_count, truncated) =
            search_in_files(&[file.clone()], "rust", SEARCH_MAX_MATCHES);
        assert!(!truncated);
        assert_eq!(file_count, 1);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[0].column, 1); // 字符空间：R 在第 1 位
        assert_eq!(matches[0].occurrence, 1);
        assert_eq!(matches[1].line, 2);
        assert_eq!(matches[1].column, 4); // “学习 ” 之后
        assert_eq!(matches[1].occurrence, 2); // 首行 1 次 + 本行第 1 次
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_skips_oversize_and_binary_files() {
        let root = temp_dir("skip");
        let bin = format!("{}/bin.md", root);
        fs::write(&bin, [0u8, 1, 2, b'a', b'b']).unwrap();
        let (matches, file_count, _) = search_in_files(&[bin], "ab", SEARCH_MAX_MATCHES);
        assert!(matches.is_empty());
        assert_eq!(file_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_truncates_preview_at_200_chars() {
        let root = temp_dir("preview");
        let file = format!("{}/long.md", root);
        let long_line: String = "字".repeat(250);
        fs::write(&file, format!("{}kw\n", long_line)).unwrap();
        let (matches, _, _) = search_in_files(&[file], "kw", SEARCH_MAX_MATCHES);
        assert_eq!(matches[0].text.chars().count(), 201); // 200 + '…'
        assert!(matches[0].text.ends_with('…'));
        let _ = fs::remove_dir_all(root);
    }
}
