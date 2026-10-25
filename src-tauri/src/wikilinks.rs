//! 双链索引（electron/wikilinks.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐的语义（JS 版在 master 仍服务于 Electron 壳，改动需两处同步）：
//! - 仅扫描 .md；单文件 2MB 上限；内容含 NUL 视为二进制跳过
//! - 围栏代码块（``` / ~~~）整体跳过；闭合须同字符；围栏行一律 continue
//! - 行级正则：\[\[([^[\\\]\n]+)\]\]（不识别行内代码中的 [[..]]，行级口径）
//! - parseWikiInner：第一个 | 切别名，| 前第一个 # 切标题，各段 trim
//! - 解析三档：①含 / 的 target 按 source 目录相对解析（支持 ../，路径规范化）
//!   ②同目录同名（.md 可省略）③全工作区去扩展名唯一名（大小写不敏感），
//!   多个同名 → ambiguous；[[#标题]]（空 target）解析为自身文档
//!
//! spike 简化：逐文件扫描顺序执行（JS 并发 8，不改变产出顺序——links 按 notes
//! 顺序组装）；路径分隔符按 POSIX 处理，Windows 迁移验收时对齐。
//!
//! @author chiangyang

use crate::search::{collect_search_files, SEARCH_MAX_FILES};
use crate::text_file::{decode, file_name_of};
use path_clean::PathClean;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

/// 单文件内容上限（与 search.cjs 的单文件上限一致）
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// 预览行文本的最大长度
const PREVIEW_LEN: usize = 200;

fn wiki_line_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // 与 wikilinks.cjs 的 WIKI_LINE_RE 一致：内容不允许 [ ] \（\n 无需排除——逐行匹配）。
        // 注意 regex crate 支持类内嵌套 [...]，内部 [ 必须转义
        regex::Regex::new(r"\[\[([^\[\]\\]+)\]\]").expect("wikilink 正则编译失败")
    })
}

fn fence_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // 与 JS 一致：^\s{0,3}(`{3,}|~{3,})
        regex::Regex::new(r"^\s{0,3}(`{3,}|~{3,})").expect("围栏正则编译失败")
    })
}

fn is_note(path: &str) -> bool {
    path.to_lowercase().ends_with(".md")
}

fn basename_no_md(path: &str) -> String {
    let base = file_name_of(path);
    base.strip_suffix(".md")
        .or_else(|| base.strip_suffix(".MD"))
        .unwrap_or(&base)
        .to_string()
}

/// POSIX 风格 join + 规范化（对应 JS path.join 的 ../ 收敛；JS 版在
/// Windows 下用反斜杠，spike 按 POSIX，正式迁移统一走此函数后补平台差异）。
fn join_normalized(dir: &str, rest: &str) -> String {
    let joined = if dir.is_empty() {
        rest.to_string()
    } else if dir.ends_with('/') {
        format!("{}{}", dir, rest)
    } else {
        format!("{}/{}", dir, rest)
    };
    Path::new(&joined).clean().to_string_lossy().into_owned()
}

/// 解析 [[...]] 内部文本 → (target, alias, heading)。
pub(crate) fn parse_wiki_inner(inner: &str) -> (String, String, String) {
    let (main, alias) = match inner.find('|') {
        Some(pipe) => (&inner[..pipe], inner[pipe + 1..].trim().to_string()),
        None => (inner, String::new()),
    };
    let (target, heading) = match main.find('#') {
        Some(hash) => (
            main[..hash].trim().to_string(),
            main[hash + 1..].trim().to_string(),
        ),
        None => (main.trim().to_string(), String::new()),
    };
    (target, alias, heading)
}

/// 单处 wikilink 出现（文件内扫描结果，resolved 由调用方补）。
struct RawLink {
    target: String,
    alias: String,
    heading: String,
    line: usize,
    text: String,
}

/// 扫描单个笔记文件中的 wikilink 出现处（围栏块内跳过）。
/// 文件不可读 / 超大 / 二进制时返回 None。
fn scan_file_links(file_path: &str) -> Option<Vec<RawLink>> {
    let meta = fs::metadata(file_path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(file_path).ok()?;
    let (_, _, content) = decode(&bytes);
    if content.contains('\0') {
        return None;
    }
    let mut targets = Vec::new();
    // 围栏状态：None 在围栏外，否则记录围栏字符（` 或 ~）——闭合须同字符
    let mut fence: Option<char> = None;
    for (i, line) in content.split('\n').enumerate() {
        let text = line.strip_suffix('\r').unwrap_or(line);
        if let Some(m) = fence_re().captures(text) {
            let ch = m.get(1).unwrap().as_str().chars().next().unwrap();
            match fence {
                None => fence = Some(ch),
                Some(open) if open == ch => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        for m in wiki_line_re().captures_iter(text) {
            let (target, alias, heading) = parse_wiki_inner(&m[1]);
            if target.is_empty() && heading.is_empty() {
                continue;
            }
            targets.push(RawLink {
                target,
                alias,
                heading,
                line: i + 1,
                text: {
                    if text.chars().count() > PREVIEW_LEN {
                        let mut s: String = text.chars().take(PREVIEW_LEN).collect();
                        s.push('…');
                        s
                    } else {
                        text.to_string()
                    }
                },
            });
        }
    }
    Some(targets)
}

/// 解析索引：全路径（小写键）→ 规范路径；文件名（去 .md，小写键）→ 路径列表。
pub(crate) struct WikiIndex {
    by_path: HashMap<String, String>,
    by_name: HashMap<String, Vec<String>>,
}

/// 构建 notes 的解析索引（两键均小写化，与 JS buildIndex 一致）
pub(crate) fn build_index(notes: &[String]) -> WikiIndex {
    let mut by_path = HashMap::with_capacity(notes.len());
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for note in notes {
        by_path.insert(note.to_lowercase(), note.clone());
        let key = basename_no_md(note).to_lowercase();
        by_name.entry(key).or_default().push(note.clone());
    }
    WikiIndex { by_path, by_name }
}

/// 双链解析结果（serde 按 JS 形状输出 {kind:'ok',path} / {kind:'ambiguous',paths} / {kind:'missing'}）。
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Resolved {
    Ok { path: String },
    Ambiguous { paths: Vec<String> },
    Missing,
}

/// 解析一个 wikilink target 为绝对路径（三档，见模块头注释）。
pub(crate) fn resolve_target(target: &str, source_path: &str, index: &WikiIndex) -> Resolved {
    let t = target.trim();
    // 空目标（[[#标题]]）= 自身文档
    if t.is_empty() {
        return Resolved::Ok {
            path: source_path.to_string(),
        };
    }
    let with_md = if t.to_lowercase().ends_with(".md") {
        t.to_string()
    } else {
        format!("{}.md", t)
    };
    let dir = match std::path::Path::new(source_path).parent() {
        Some(p) => p.to_string_lossy().into_owned(),
        None => String::new(),
    };
    if t.contains('/') || t.contains('\\') {
        // 相对路径档：按 source 所在目录解析（target 可含子目录与 ../）
        let joined = join_normalized(&dir, &with_md);
        return match index.by_path.get(&joined.to_lowercase()) {
            Some(p) => Resolved::Ok { path: p.clone() },
            None => Resolved::Missing,
        };
    }
    // 同目录同名档
    let same_dir = join_normalized(&dir, &with_md);
    if let Some(p) = index.by_path.get(&same_dir.to_lowercase()) {
        return Resolved::Ok { path: p.clone() };
    }
    // 全工作区文件名唯一匹配档
    let key = basename_no_md(t).to_lowercase();
    match index.by_name.get(&key) {
        None => Resolved::Missing,
        Some(list) if list.len() == 1 => Resolved::Ok {
            path: list[0].clone(),
        },
        Some(list) => Resolved::Ambiguous {
            paths: list.clone(),
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiScanNote {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiLinkRef {
    pub source: String,
    pub target: String,
    pub alias: String,
    pub heading: String,
    pub line: usize,
    pub text: String,
    pub resolved: Resolved,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiScanResult {
    pub notes: Vec<WikiScanNote>,
    pub links: Vec<WikiLinkRef>,
    pub truncated: bool,
}

/// 扫描工作区全部笔记的 wikilink：files 为 collect_search_files 的产出，
/// 这里只做 .md 过滤（与 JS 的调用结构一致）→ notes + 逐处解析后的链接边。
pub(crate) fn scan_wiki_links(roots: &[String]) -> WikiScanResult {
    let (files, truncated) = collect_search_files(roots, SEARCH_MAX_FILES);
    let notes: Vec<String> = files.into_iter().filter(|f| is_note(f)).collect();
    let index = build_index(&notes);

    let mut links: Vec<WikiLinkRef> = Vec::new();
    for source in &notes {
        let Some(targets) = scan_file_links(source) else {
            continue;
        };
        for t in targets {
            let resolved = resolve_target(&t.target, source, &index);
            links.push(WikiLinkRef {
                source: source.clone(),
                target: t.target,
                alias: t.alias,
                heading: t.heading,
                line: t.line,
                text: t.text,
                resolved,
            });
        }
    }
    let notes = notes
        .into_iter()
        .map(|p| {
            let name = file_name_of(&p);
            WikiScanNote { path: p, name }
        })
        .collect();
    WikiScanResult {
        notes,
        links,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("tmd-spike-wiki-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn parse_wiki_inner_splits_alias_heading_and_trims() {
        assert_eq!(
            parse_wiki_inner("目标"),
            ("目标".into(), "".into(), "".into())
        );
        assert_eq!(
            parse_wiki_inner(" 目标 | 别名 "),
            ("目标".into(), "别名".into(), "".into())
        );
        assert_eq!(
            parse_wiki_inner("目标#标题|别名"),
            ("目标".into(), "别名".into(), "标题".into())
        );
        assert_eq!(
            parse_wiki_inner("#仅标题"),
            ("".into(), "".into(), "仅标题".into())
        );
    }

    #[test]
    fn scan_skips_fenced_code_blocks_but_not_inline_code() {
        let root = temp_dir("fence");
        let file = format!("{}/a.md", root);
        fs::write(
            &file,
            "[[真实]]\n```rust\n[[围栏内]]\n```\n行内 `[[代码内]]` 与 [[也真实]]\n~~~\n[[波浪围栏]]\n~~~\n",
        )
        .unwrap();
        let links = scan_file_links(&file).unwrap();
        // 围栏内整体跳过；行内代码中的 [[..]] 仍被收集（行级正则的已知边界，与 JS 一致）
        let targets: Vec<&str> = links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["真实", "代码内", "也真实"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_three_tiers_with_parent_dir_and_ambiguity() {
        let root = temp_dir("resolve");
        fs::create_dir_all(format!("{}/sub", root)).unwrap();
        fs::create_dir_all(format!("{}/other", root)).unwrap();
        let a = format!("{}/sub/alpha.md", root);
        let b = format!("{}/beta.md", root);
        let c = format!("{}/sub/beta.md", root);
        let dup1 = format!("{}/dup.md", root);
        let dup2 = format!("{}/sub/dup.md", root);
        let other = format!("{}/other/src.md", root);
        for f in [&a, &b, &c, &dup1, &dup2, &other] {
            fs::write(f, "x").unwrap();
        }
        let notes = vec![
            a.clone(),
            b.clone(),
            c.clone(),
            dup1.clone(),
            dup2.clone(),
            other.clone(),
        ];
        let index = build_index(&notes);

        // ① 相对路径档（含 ../）
        match resolve_target("../beta", &a, &index) {
            Resolved::Ok { path } => assert_eq!(path, b),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        // ② 同目录同名档（.md 省略）
        match resolve_target("beta", &a, &index) {
            Resolved::Ok { path } => assert_eq!(path, c),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        // ③ 全工作区唯一名档
        match resolve_target("alpha", &b, &index) {
            Resolved::Ok { path } => assert_eq!(path, a),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        // ② 档优先于 ③：root/beta.md 发起的 dup 命中同目录，不进入全局档
        match resolve_target("dup", &b, &index) {
            Resolved::Ok { path } => assert_eq!(path, dup1),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        // 多个同名 → ambiguous（从 dup 不存在的 other/ 目录发起，② 档落空进 ③ 档）
        match resolve_target("dup", &other, &index) {
            Resolved::Ambiguous { paths } => assert_eq!(paths.len(), 2),
            other => panic!("期望 ambiguous，得到 {:?}", other),
        }
        // [[#标题]]（空 target）→ 自身文档（resolve_target 收到的是 parse_wiki_inner
        // 解析后的 target，[[#标题]] 解析结果即空串）
        match resolve_target("", &a, &index) {
            Resolved::Ok { path } => assert_eq!(path, a),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        // 完全不存在
        assert!(matches!(
            resolve_target("ghost", &b, &index),
            Resolved::Missing
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_wiki_links_end_to_end_shapes() {
        let root = temp_dir("e2e");
        let a = format!("{}/a.md", root);
        let b = format!("{}/b.md", root);
        fs::write(&a, "链接到 [[b]] 与 [[b|别名]]\n").unwrap();
        fs::write(&b, "回到 [[a#某节]]\n").unwrap();
        let result = scan_wiki_links(&[root.clone()]);
        assert_eq!(result.notes.len(), 2);
        assert_eq!(result.links.len(), 3);
        // notes 顺序来自 readdir（不保证字典序），断言按 target 归组而非下标
        let to_b: Vec<_> = result.links.iter().filter(|l| l.target == "b").collect();
        assert_eq!(to_b.len(), 2);
        assert_eq!(to_b[0].source, a);
        assert_eq!(to_b[0].alias, "");
        assert_eq!(to_b[1].alias, "别名");
        assert_eq!(to_b[0].text, "链接到 [[b]] 与 [[b|别名]]");
        match &to_b[0].resolved {
            Resolved::Ok { path } => assert_eq!(path, &b),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        let to_a: Vec<_> = result.links.iter().filter(|l| l.target == "a").collect();
        assert_eq!(to_a.len(), 1);
        assert_eq!(to_a[0].source, b);
        assert_eq!(to_a[0].heading, "某节");
        match &to_a[0].resolved {
            Resolved::Ok { path } => assert_eq!(path, &a),
            other => panic!("期望 ok，得到 {:?}", other),
        }
        let _ = fs::remove_dir_all(root);
    }
}
