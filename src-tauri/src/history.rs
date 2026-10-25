//! 本地历史版本（文件快照）——electron/history.cjs 的 Rust 移植。
//!
//! 写盘覆盖前把旧内容存档，仅提供人工恢复入口。与 JS 版逐项对齐的语义
//! （JS 版保留服务 Electron 壳，改动需两处同步）：
//! - 目录约定：`<资产根>/.tmd/history/<key>/`，key = 源文件绝对路径 sha1 前 16 位
//!   （非 Linux 统一小写，避免大小写不敏感文件系统上同一文件分裂成两份历史）；
//!   `index.json`（元信息清单，最新在前）+ `<id>.md`（正文，id = 本地时间戳）
//! - 去重：空内容不存；与最新一条内容指纹相同不存（自动保存每 5 秒写盘的护栏）
//! - 同秒冲突：id 追加 -2、-3…
//! - 双层剪枝：单文件 50 条（写入时内联收口）+ 全局 200MB（每 20 次写入或
//!   触及单文件上限时跨文件按时间最旧优先删）
//! - index 走临时文件 + 原子替换；损坏的 index 改名留档 7 天后清理
//! - 失败静默降级：快照故障绝不阻断保存
//!
//! 保存事务（评估 §3.2）：snapshot → write → note_write 三步有序，由
//! main.rs 的保存命令在同一 Rust 调用内完成，前端不参与编排。
//!
//! @author chiangyang

use crate::text_file::{decode, file_name_of};
use crate::watcher::sha1_hex;
use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// 每个源文件保留的最多快照数（超出按时间最旧优先删除）
pub(crate) const HISTORY_MAX_PER_FILE: usize = 50;
/// 历史目录总容量上限（字节）；超出后跨文件按时间最旧优先删除
pub(crate) const HISTORY_MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
/// 单条快照读取上限（50MB）：旧版本可能留下超大快照，预览时不能整份读入
pub(crate) const HISTORY_MAX_SNAPSHOT_BYTES: u64 = 50 * 1024 * 1024;
/// 单文件读入上限（写前快照沿用与 IPC 读取通道同口径的护栏）
const READ_CAP_BYTES: u64 = 50 * 1024 * 1024;
/// 全局容量剪枝的执行频率：每 N 次快照写入跑一次（写入侧降频）
const PRUNE_EVERY_WRITES: usize = 20;
/// 损坏留档保留时长（7 天，过期即删）
const CORRUPT_KEEP_MS: u128 = 7 * 24 * 60 * 60 * 1000;

/// 进程内写入计数（仅用于剪枝节流，不持久化）
static WRITE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// TMD 用户资产根目录：TMD_HOME_DIR 优先（E2E 隔离 / 便携版），否则用户主目录。
/// 与 electron/logger.cjs 的 tmdHome() 对齐。
pub(crate) fn tmd_home() -> PathBuf {
    if let Ok(custom) = std::env::var("TMD_HOME_DIR") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 历史版本根目录：`<资产根>/.tmd/history`
pub(crate) fn history_root() -> PathBuf {
    tmd_home().join(".tmd").join("history")
}

/// 源文件路径 → 快照目录名（绝对化 + 非 Linux 小写 + sha1 前 16 位）。
pub(crate) fn snapshot_key(file_path: &str) -> String {
    let resolved = std::path::absolute(file_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| file_path.to_string());
    let normalized = if cfg!(target_os = "linux") {
        resolved
    } else {
        resolved.to_lowercase()
    };
    sha1_hex(&normalized)[..16].to_string()
}

fn snapshot_dir(root: &Path, file_path: &str) -> PathBuf {
    root.join(snapshot_key(file_path))
}

/// id 合法性校验（YYYYMMDD-HHmmss 及 -2/-3 序号）：读取/删除前必查，杜绝目录穿越。
pub(crate) fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    // 15 位主干（8+1+6）或 15 + "-n"
    if !(bytes.len() == 15
        || (bytes.len() > 16 && bytes[15] == b'-' && bytes[16..].iter().all(u8::is_ascii_digit)))
    {
        return false;
    }
    bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[8] == b'-'
        && bytes[9..15].iter().all(u8::is_ascii_digit)
}

/// index.json 的 Rust 形状（字段名与 JS 版 JSON 完全一致）
#[derive(Serialize, Deserialize)]
struct IndexEntry {
    id: String,
    ts: String,
    size: u64,
    hash: String,
}

#[derive(Serialize, Deserialize)]
struct HistoryIndex {
    path: String,
    name: String,
    snapshots: Vec<IndexEntry>,
}

/// 读取快照目录的 index.json；缺失 → None；损坏 → 改名留档后 None
/// （否则后续 writeSnapshot 会以空列表为基底覆盖，旧元信息永久丢失）。
fn read_index(dir: &Path) -> Option<HistoryIndex> {
    let file = dir.join("index.json");
    let raw = fs::read_to_string(&file).ok()?;
    let parsed: Option<HistoryIndex> = serde_json::from_str(&raw).ok();
    match parsed {
        Some(index) => Some(index),
        None => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = fs::rename(&file, dir.join(format!("index.json.corrupt-{}", stamp)));
            None
        }
    }
}

/// 写入 index.json：临时文件 + 原子替换；失败静默（历史不值得打扰用户）。
fn write_index(dir: &Path, index: &HistoryIndex) {
    let file = dir.join("index.json");
    let tmp = dir.join("index.json.tmp");
    match serde_json::to_string_pretty(index) {
        Ok(json) => {
            if fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &file)).is_err() {
                let _ = fs::remove_file(&tmp);
            }
        }
        Err(_) => {
            let _ = fs::remove_file(&tmp);
        }
    }
}

/// 删除单条快照正文（id 再校验防目录穿越；force 静默缺失）。
fn remove_snapshot(dir: &Path, id: &str) {
    if !is_valid_id(id) {
        return;
    }
    let _ = fs::remove_file(dir.join(format!("{}.md", id)));
}

/// 生成不与既有快照冲突的 id（同秒多次保存追加序号）。
fn unique_id(used: &std::collections::HashSet<String>, now: &DateTime<Local>) -> String {
    let base = now.format("%Y%m%d-%H%M%S").to_string();
    if !used.contains(&base) {
        return base;
    }
    let mut n = 2;
    while used.contains(&format!("{}-{}", base, n)) {
        n += 1;
    }
    format!("{}-{}", base, n)
}

/// 记录一条快照（写盘覆盖前调用，content 为即将被覆盖的旧内容）。
/// 返回 Ok(id) 或 Err(reason)；失败静默由调用方保证（不阻断保存）。
fn write_snapshot(
    root: &Path,
    file_path: &str,
    name: &str,
    content: &str,
    now: Option<DateTime<Local>>,
) -> Result<String, &'static str> {
    if file_path.is_empty() {
        return Err("no-path");
    }
    if content.is_empty() {
        return Err("empty");
    }
    let now = now.unwrap_or_else(Local::now);
    let dir = snapshot_dir(root, file_path);
    let existing = read_index(&dir);
    let hash = sha1_hex(content);
    let snapshots = existing.map(|i| i.snapshots).unwrap_or_default();
    if snapshots.first().is_some_and(|s| s.hash == hash) {
        return Err("duplicate");
    }

    let used: std::collections::HashSet<String> = snapshots.iter().map(|s| s.id.clone()).collect();
    let id = unique_id(&used, &now);
    fs::create_dir_all(&dir).map_err(|_| "write-failed")?;
    fs::write(dir.join(format!("{}.md", id)), content.as_bytes()).map_err(|_| "write-failed")?;

    // 源文件可能被重命名 / 移动：index 里的路径与文件名以最新一次为准
    let mut next = HistoryIndex {
        path: file_path.to_string(),
        name: if name.is_empty() {
            file_name_of(file_path)
        } else {
            name.to_string()
        },
        snapshots: Vec::with_capacity(snapshots.len() + 1),
    };
    next.snapshots.push(IndexEntry {
        id: id.clone(),
        ts: now.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true),
        size: content.as_bytes().len() as u64,
        hash,
    });
    next.snapshots.extend(snapshots);

    // 单文件数量上限内联收口：只触碰本文件的 index 与快照文件
    let overflow: Vec<IndexEntry> =
        next.snapshots.split_off(HISTORY_MAX_PER_FILE.min(next.snapshots.len()));
    write_index(&dir, &next);
    for s in &overflow {
        remove_snapshot(&dir, &s.id);
    }

    // 全局容量剪枝降频（见模块头注释）；单文件触顶时立即执行一次
    let count = WRITE_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    if count % PRUNE_EVERY_WRITES == 0 || !overflow.is_empty() {
        prune_history_with(root, HISTORY_MAX_TOTAL_BYTES);
    }
    Ok(id)
}

/// 清理目录内过期损坏留档（readIndex 的 rename 产物，保留 7 天）。
fn cleanup_corrupt_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .saturating_sub(CORRUPT_KEEP_MS);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stamp) = name
            .strip_prefix("index.json.corrupt-")
            .and_then(|s| s.parse::<u128>().ok())
        else {
            continue;
        };
        if stamp <= cutoff {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 剪枝：一次遍历同时完成单文件数量上限与全局容量上限两层。
/// 返回 (removed, 剩余总字节)。
fn prune_history_with(root: &Path, max_total: u64) -> (usize, u64) {
    let Ok(entries) = fs::read_dir(root) else {
        return (0, 0); // 历史目录尚不存在
    };
    let mut removed = 0usize;
    let mut total: u64 = 0;
    struct Entry {
        dir: PathBuf,
        index: HistoryIndex,
    }
    let mut all: Vec<Entry> = Vec::new();
    for key in entries.flatten() {
        let dir = key.path();
        if !dir.is_dir() {
            continue;
        }
        cleanup_corrupt_files(&dir);
        let Some(mut index) = read_index(&dir) else {
            continue;
        };
        if index.snapshots.len() > HISTORY_MAX_PER_FILE {
            let drop: Vec<IndexEntry> = index.snapshots.split_off(HISTORY_MAX_PER_FILE);
            for s in &drop {
                remove_snapshot(&dir, &s.id);
                removed += 1;
            }
            write_index(&dir, &index);
        }
        total += index.snapshots.iter().map(|s| s.size).sum::<u64>();
        all.push(Entry { dir, index });
    }

    if total <= max_total {
        return (removed, total);
    }

    // 容量剪：跨文件扁平化按时间从旧到新删，直到回落上限之内
    // （JS 用 localeCompare；同为 ISO 8601 格式时字符串序即时间序）
    let mut flat: Vec<(usize, String, String, u64)> = Vec::new(); // (entry_idx, id, ts, size)
    for (i, entry) in all.iter().enumerate() {
        for s in &entry.index.snapshots {
            flat.push((i, s.id.clone(), s.ts.clone(), s.size));
        }
    }
    flat.sort_by(|a, b| a.2.cmp(&b.2));
    let mut removed_ids: Vec<std::collections::HashSet<String>> =
        vec![std::collections::HashSet::new(); all.len()];
    for (ei, id, _ts, size) in &flat {
        if total <= max_total {
            break;
        }
        remove_snapshot(&all[*ei].dir, id);
        removed += 1;
        total -= size;
        removed_ids[*ei].insert(id.clone());
    }
    for (i, entry) in all.iter_mut().enumerate() {
        if removed_ids[i].is_empty() {
            continue;
        }
        entry.index.snapshots.retain(|s| !removed_ids[i].contains(&s.id));
        write_index(&entry.dir, &entry.index);
    }
    (removed, total.max(0))
}

// ---------- 对外通道（native.ts listHistory / readHistory） ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotMeta {
    pub id: String,
    pub ts: String,
    pub size: u64,
}

#[derive(Serialize)]
pub(crate) struct FileHistory {
    pub path: String,
    pub name: String,
    pub snapshots: Vec<SnapshotMeta>,
}

#[derive(Serialize)]
pub(crate) struct HistoryEntry {
    pub id: String,
    pub ts: String,
    pub content: String,
}

/// 列出某源文件的全部快照（最新在前）。无历史 → None。
pub(crate) fn list_snapshots(root: &Path, file_path: &str) -> Option<FileHistory> {
    if file_path.is_empty() {
        return None;
    }
    let index = read_index(&snapshot_dir(root, file_path))?;
    if index.snapshots.is_empty() {
        return None;
    }
    // hash 是内部去重用的，不外传
    Some(FileHistory {
        path: index.path,
        name: index.name,
        snapshots: index
            .snapshots
            .into_iter()
            .map(|s| SnapshotMeta {
                id: s.id,
                ts: s.ts,
                size: s.size,
            })
            .collect(),
    })
}

/// 读取单条快照正文。id 非法、缺失、非普通文件或超过 50MB → None。
pub(crate) fn read_snapshot(root: &Path, file_path: &str, id: &str) -> Option<HistoryEntry> {
    if !is_valid_id(id) || file_path.is_empty() {
        return None;
    }
    let dir = snapshot_dir(root, file_path);
    let file = dir.join(format!("{}.md", id));
    // 旧版本可能留下超大快照：先 stat 预检，避免预览把整份内容读进内存
    let stat = fs::metadata(&file).ok()?;
    if !stat.is_file() || stat.len() > HISTORY_MAX_SNAPSHOT_BYTES {
        return None;
    }
    let bytes = fs::read(&file).ok()?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let ts = read_index(&dir)
        .and_then(|index| index.snapshots.into_iter().find(|s| s.id == id))
        .map(|s| s.ts)
        .unwrap_or_default();
    Some(HistoryEntry {
        id: id.to_string(),
        ts,
        content,
    })
}

/// 保存前快照（snapshotBeforeWrite 的 Rust 对应）：读取被覆盖的旧内容并存档。
/// 失败静默：文件不存在（首次保存）/ 读取失败 / 超过 50MB 上限 → 无旧内容可存。
pub(crate) fn snapshot_before_write(root: &Path, file_path: &str) {
    let Ok(meta) = fs::metadata(file_path) else {
        return;
    };
    if !meta.is_file() || meta.len() > READ_CAP_BYTES {
        return;
    }
    let Ok(bytes) = fs::read(file_path) else {
        return;
    };
    let (_, _, content) = decode(&bytes);
    if content.is_empty() {
        return;
    }
    let _ = write_snapshot(root, file_path, &file_name_of(file_path), &content, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tmd-spike-history-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn local_from_yyyy(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Local> {
        use chrono::TimeZone;
        Local.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap()
    }

    #[test]
    fn write_list_roundtrip_and_dedup() {
        let root = temp_root("roundtrip");
        let file = "/tmp/tmd-history-fake/a.md";
        let t = local_from_yyyy(2026, 10, 25, 9, 0, 0);
        let id = write_snapshot(&root, file, "a.md", "第一版", Some(t)).unwrap();
        assert_eq!(id, "20261025-090000");
        // 与最新一条相同 → duplicate 不存
        assert_eq!(
            write_snapshot(&root, file, "a.md", "第一版", Some(t)).unwrap_err(),
            "duplicate"
        );
        // 空内容不存
        assert_eq!(write_snapshot(&root, file, "a.md", "", Some(t)).unwrap_err(), "empty");
        let list = list_snapshots(&root, file).unwrap();
        assert_eq!(list.path, file);
        assert_eq!(list.snapshots.len(), 1);
        assert_eq!(list.snapshots[0].id, id);
        let entry = read_snapshot(&root, file, &id).unwrap();
        assert_eq!(entry.content, "第一版");
        assert!(!entry.ts.is_empty());
        // 无历史文件 → None
        assert!(list_snapshots(&root, "/tmp/tmd-history-fake/ghost.md").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_second_ids_get_sequence_suffix() {
        let root = temp_root("seq");
        let file = "/tmp/tmd-history-fake/b.md";
        let t = local_from_yyyy(2026, 10, 25, 9, 1, 5);
        let id1 = write_snapshot(&root, file, "b.md", "v1", Some(t)).unwrap();
        let id2 = write_snapshot(&root, file, "b.md", "v2", Some(t)).unwrap();
        assert_eq!(id1, "20261025-090105");
        assert_eq!(id2, "20261025-090105-2");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn per_file_cap_prunes_oldest() {
        let root = temp_root("cap");
        let file = "/tmp/tmd-history-fake/c.md";
        // 写 52 条（第 i 条内容不同、时间为 00:i:00），只留最新 50 条
        for i in 0..52 {
            let t = local_from_yyyy(2026, 1, 1, 0, i as u32, 0);
            write_snapshot(&root, file, "c.md", &format!("v{}", i), Some(t)).unwrap();
        }
        let list = list_snapshots(&root, file).unwrap();
        assert_eq!(list.snapshots.len(), HISTORY_MAX_PER_FILE);
        assert_eq!(list.snapshots[0].id, "20260101-005100"); // 最新在前（i=51）
        assert_eq!(list.snapshots.last().unwrap().id, "20260101-000200"); // 最旧保留（i=2）
        // 被剪掉的正文文件也已删除
        assert!(!root.join(snapshot_key(file)).join("20260101-000000.md").exists());
        assert!(!root.join(snapshot_key(file)).join("20260101-000100.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_cap_prunes_oldest_across_files() {
        let root = temp_root("global");
        let file_a = "/tmp/tmd-history-fake/d.md";
        let file_b = "/tmp/tmd-history-fake/e.md";
        // 每条 8 字节（"内容A0"：中文 2 字×3B + ASCII 2B，内容互异以绕过去重），
        // a 3 条 + b 3 条共 48 字节
        for i in 0..3 {
            let t = local_from_yyyy(2026, 1, 1, 0, i, 0);
            write_snapshot(&root, file_a, "d.md", &format!("内容A{}", i), Some(t)).unwrap();
            let t2 = local_from_yyyy(2026, 1, 1, 1, i, 0);
            write_snapshot(&root, file_b, "e.md", &format!("内容B{}", i), Some(t2)).unwrap();
        }
        // 显式触发容量剪（单文件上限未触及）：上限 35 → 从最旧起删 2 条回落 32
        let (removed, total) = prune_history_with(&root, 35);
        assert_eq!(removed, 2);
        assert!(total <= 35);
        // 最旧的一条（a 的 00:00）应被先删，最新保留
        assert!(read_snapshot(&root, file_a, "20260101-000000").is_none());
        assert!(read_snapshot(&root, file_a, "20260101-000100").is_none());
        assert!(read_snapshot(&root, file_a, "20260101-000200").is_some());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_index_is_quarantined() {
        let root = temp_root("corrupt");
        let file = "/tmp/tmd-history-fake/f.md";
        let dir = root.join(snapshot_key(file));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("index.json"), "{broken json").unwrap();
        assert!(list_snapshots(&root, file).is_none());
        // 原 index 被改名留档而非删除
        let quarantined: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("index.json.corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn id_validation_blocks_traversal() {
        assert!(is_valid_id("20261025-090000"));
        assert!(is_valid_id("20261025-090000-2"));
        assert!(!is_valid_id("../../etc/passwd"));
        assert!(!is_valid_id("20261025090000"));
        assert!(!is_valid_id("20261025-0900"));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn snapshot_key_is_stable_and_case_insensitive_off_linux() {
        let k1 = snapshot_key("/Users/x/Notes/A.md");
        let k2 = snapshot_key("/Users/x/Notes/a.md");
        let k3 = snapshot_key("/Users/x/Notes/A.md");
        assert_eq!(k1, k3);
        if cfg!(target_os = "linux") {
            assert_ne!(k1, k2);
        } else {
            assert_eq!(k1, k2);
        }
        assert_eq!(k1.len(), 16);
    }

    #[test]
    fn snapshot_before_write_archives_previous_content() {
        let root = temp_root("before");
        let real = root.join("real.md");
        fs::write(&real, "旧内容").unwrap();
        snapshot_before_write(&root, &real.to_string_lossy());
        let list = list_snapshots(&root, &real.to_string_lossy()).unwrap();
        assert_eq!(list.snapshots.len(), 1);
        let id = &list.snapshots[0].id;
        let entry = read_snapshot(&root, &real.to_string_lossy(), id).unwrap();
        assert_eq!(entry.content, "旧内容");
        // 首次保存（文件不存在）→ 静默无快照
        snapshot_before_write(&root, &root.join("ghost.md").to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }
}
