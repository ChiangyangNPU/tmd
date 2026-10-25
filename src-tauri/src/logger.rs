//! 本地日志与崩溃线索（electron/logger.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐（JS 版保留服务 Electron 壳，改动需两处同步）：
//! - `~/.tmd/logs/app-YYYY-MM-DD.jsonl` 按天滚动（本地时区），双层保留清理：
//!   mtime 超 7 天全删 + 超出 10 个文件的最旧一批删（每次写盘顺带轮转）
//! - 同 source+message 在 60 秒固定窗口内重复仅计数不落盘；窗口期满后由下一条
//!   任意日志「顺带」冲刷出汇总行（无后台定时器；固定窗口起点不随重复刷新——
//!   持续重复的错误在窗口期满后必然可再次落盘）
//! - 字段白名单 + 级别/来源白名单 + 单字段 4096 截断；非法入参丢弃
//! - 崩溃线索：扫描 `~/.tmd/crash-dumps` 递归收集 minidump（crashpad 放在
//!   pending/ 等子目录），对照 `.seen-dumps` 清单补记「上次运行留下的崩溃」
//! - 零遥传；写盘失败静默（日志故障不打挂应用、不递归进异常钩子）
//!
//! Tauri 侧的差异：Rust 无 crashReporter 对应物，但资产根 `~/.tmd` 与
//! Electron 版共享——Tauri 启动时同样扫描崩溃目录，可补记 Electron 版
//! 上次运行留下的 minidump 线索；panic hook 写入 'main' 来源日志。

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 日志保留天数（mtime 早于此刻 7 天的日文件删除）
pub(crate) const LOG_RETENTION_DAYS: i64 = 7;
/// 日志文件数上限（清理超龄文件后仍多于该数时，从最旧开始删）
pub(crate) const LOG_RETENTION_FILES: usize = 10;
/// 单个文本字段（message/stack）长度上限，超出截断
pub(crate) const FIELD_MAX: usize = 4096;
/// 同 source+message 去重窗口：窗口内重复仅计数、不重复落盘
pub(crate) const DEDUP_WINDOW_MS: u128 = 60 * 1000;

/// 日志目录绝对路径：`<资产根>/.tmd/logs`
pub(crate) fn logs_dir(home: &Path) -> PathBuf {
    home.join(".tmd").join("logs")
}

/// 原生崩溃 minidump 目录绝对路径：`<资产根>/.tmd/crash-dumps`
pub(crate) fn crash_dumps_dir(home: &Path) -> PathBuf {
    home.join(".tmd").join("crash-dumps")
}

/// 本地日期串 YYYY-MM-DD（日文件按本地天滚动）
pub(crate) fn local_date(now: &DateTime<Local>) -> String {
    now.format("%Y-%m-%d").to_string()
}

/// 指定日期对应的日志文件名
pub(crate) fn log_file_name(date: &str) -> String {
    format!("app-{}.jsonl", date)
}

/// 轮转决策：超龄（mtime < now-7天）全删；未超龄按 mtime 从旧到新，
/// 超出 10 个上限的最旧一批一并删除。纯函数。
pub(crate) fn prune_log_files(entries: &[(String, u128)], now_ms: u128) -> Vec<String> {
    let cutoff = now_ms.saturating_sub(LOG_RETENTION_DAYS as u128 * 24 * 60 * 60 * 1000);
    let aged: Vec<String> = entries
        .iter()
        .filter(|(_, mtime)| *mtime < cutoff)
        .map(|(name, _)| name.clone())
        .collect();
    let mut fresh: Vec<(String, u128)> = entries
        .iter()
        .filter(|(_, mtime)| *mtime >= cutoff)
        .cloned()
        .collect();
    fresh.sort_by_key(|(_, mtime)| *mtime);
    let excess = fresh.len().saturating_sub(LOG_RETENTION_FILES);
    let overflow = fresh[..excess].iter().map(|(name, _)| name.clone());
    aged.into_iter().chain(overflow).collect()
}

/// 文本字段截断：超 FIELD_MAX 裁剪并附截断标记
pub(crate) fn truncate_field(s: &str) -> String {
    if s.chars().count() > FIELD_MAX {
        let mut out: String = s.chars().take(FIELD_MAX).collect();
        out.push_str("…[truncated]");
        out
    } else {
        s.to_string()
    }
}

/// 允许的级别 / 来源白名单（IPC 入参不接受级别，渲染层上报固定 error）
const LEVELS: &[&str] = &["error", "warn"];
const SOURCES: &[&str] = &["main", "renderer", "child-process", "native-crash"];

/// 附加元信息（字段全部白名单化，非法即丢弃）
#[derive(Default)]
pub(crate) struct LogMeta<'a> {
    pub filename: Option<&'a str>,
    pub lineno: Option<f64>,
    pub colno: Option<f64>,
    pub reason: Option<&'a str>,
    pub exit_code: Option<f64>,
    pub dump: Option<&'a str>,
}

/// 组装一条合法日志记录；非法级别/来源或缺 message → None（丢弃垃圾入参）。
pub(crate) fn build_entry(
    level: &str,
    source: &str,
    message: &str,
    stack: Option<&str>,
    meta: &LogMeta,
    now: &DateTime<Local>,
) -> Option<Value> {
    if !LEVELS.contains(&level) || !SOURCES.contains(&source) {
        return None;
    }
    if message.is_empty() {
        return None;
    }
    let mut entry = serde_json::json!({
        "ts": now.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true),
        "level": level,
        "source": source,
        "message": truncate_field(message),
    });
    let obj = entry.as_object_mut().expect("json! 必为对象");
    if let Some(stack) = stack.filter(|s| !s.is_empty()) {
        obj.insert("stack".into(), Value::String(truncate_field(stack)));
    }
    if let Some(filename) = meta.filename.filter(|s| !s.is_empty()) {
        obj.insert("filename".into(), Value::String(truncate_field(filename)));
    }
    if let Some(lineno) = meta.lineno.filter(|n| n.is_finite()) {
        obj.insert("lineno".into(), Value::from(lineno));
    }
    if let Some(colno) = meta.colno.filter(|n| n.is_finite()) {
        obj.insert("colno".into(), Value::from(colno));
    }
    if let Some(reason) = meta.reason.filter(|s| !s.is_empty()) {
        obj.insert("reason".into(), Value::String(truncate_field(reason)));
    }
    if let Some(exit_code) = meta.exit_code.filter(|n| n.is_finite()) {
        obj.insert("exitCode".into(), Value::from(exit_code));
    }
    if let Some(dump) = meta.dump.filter(|s| !s.is_empty()) {
        obj.insert("dump".into(), Value::String(truncate_field(dump)));
    }
    Some(entry)
}

/// 渲染层经 IPC 上报的错误载荷（归一化：来源固定 renderer、级别固定 error）
#[derive(Debug, Clone)]
pub(crate) struct RendererReport {
    pub message: String,
    pub stack: Option<String>,
    pub filename: Option<String>,
    pub lineno: Option<f64>,
    pub colno: Option<f64>,
}

/// 校验并归一化渲染层上报载荷：只接受白名单字段，非字符串/越界一律丢弃
pub(crate) fn normalize_renderer_report(raw: &Value) -> Option<RendererReport> {
    let obj = raw.as_object()?;
    let message = obj.get("message").and_then(Value::as_str)?;
    if message.is_empty() {
        return None;
    }
    let num = |key: &str| -> Option<f64> {
        obj.get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    let str_field = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(truncate_field)
    };
    Some(RendererReport {
        message: truncate_field(message),
        stack: str_field("stack"),
        filename: str_field("filename"),
        lineno: num("lineno"),
        colno: num("colno"),
    })
}

/// 从未见过的 minidump 文件名清单（对照 .seen-dumps 的纯集合差集）
pub(crate) fn list_new_dumps(files: &[String], seen: &[String]) -> Vec<String> {
    let known: std::collections::HashSet<&String> = seen.iter().collect();
    files
        .iter()
        .filter(|name| name.ends_with(".dmp") && !known.contains(*name))
        .cloned()
        .collect()
}

/// 递归收集崩溃目录下全部 minidump 的相对路径（crashpad 以数据库形式管理，
/// .dmp 实际落在 pending/ 等子目录，只读顶层会漏掉全部转储）
pub(crate) fn collect_dump_files(dir: &Path, prefix: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };
        let path = dir.join(&name);
        if path.is_dir() {
            out.extend(collect_dump_files(&path, &rel));
        } else if path.is_file() && name.ends_with(".dmp") {
            out.push(rel);
        }
    }
    out
}

// ---------- 日志写入器 ----------

struct DedupRec {
    count: usize,
    at_ms: u128,
    source: String,
    message: String,
}

pub(crate) struct Logger {
    home: PathBuf,
    inner: Mutex<LoggerInner>,
}

struct LoggerInner {
    recent: HashMap<String, DedupRec>,
}

impl Logger {
    pub fn new(home: PathBuf) -> Arc<Self> {
        Arc::new(Logger {
            home,
            inner: Mutex::new(LoggerInner {
                recent: HashMap::new(),
            }),
        })
    }

    /// 记录一条日志（level/source 白名单外的入参静默丢弃）
    pub fn log(
        &self,
        level: &str,
        source: &str,
        message: &str,
        stack: Option<&str>,
        meta: &LogMeta,
    ) {
        let now = Local::now();
        let at_ms = now.timestamp_millis() as u128;
        self.log_at(at_ms, level, source, message, stack, meta);
    }

    /// 带时间注入的内部实现（测试用）；生产方 log() 直接取当前时间。
    fn log_at(
        &self,
        at_ms: u128,
        level: &str,
        source: &str,
        message: &str,
        stack: Option<&str>,
        meta: &LogMeta,
    ) {
        let mut g = self.inner.lock().expect("logger 锁中毒");
        Self::flush_expired(&mut g.recent, at_ms, &self.home);
        let Some(entry) = build_entry(level, source, message, stack, meta, &Local::now()) else {
            return;
        };
        let key = format!("{}\u{0}{}", source, message);
        if let Some(hit) = g.recent.get_mut(&key) {
            // 固定窗口：窗口起点保持首次出现时间，不随重复刷新（语义见模块头）
            hit.count += 1;
            return;
        }
        g.recent.insert(
            key,
            DedupRec {
                count: 1,
                at_ms,
                source: source.to_string(),
                message: entry
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
        );
        drop(g);
        Self::append_raw(&self.home, &entry);
    }

    /// 冲刷所有已过窗口且发生过重复的去重记录（汇总成行），并清空过期记录
    fn flush_expired(recent: &mut HashMap<String, DedupRec>, at_ms: u128, home: &Path) {
        let expired: Vec<DedupRec> = recent
            .iter()
            .filter(|(_, rec)| at_ms.saturating_sub(rec.at_ms) >= DEDUP_WINDOW_MS)
            .map(|(_, rec)| DedupRec {
                count: rec.count,
                at_ms: rec.at_ms,
                source: rec.source.clone(),
                message: rec.message.clone(),
            })
            .collect();
        for rec in expired {
            recent.remove(&format!("{}\u{0}{}", rec.source, rec.message));
            if rec.count >= 2 {
                let summary = format!(
                    "相同消息在 {} 秒内重复 {} 次: {}",
                    DEDUP_WINDOW_MS / 1000,
                    rec.count,
                    rec.message
                );
                if let Some(entry) = build_entry(
                    "warn",
                    &rec.source,
                    &summary,
                    None,
                    &LogMeta::default(),
                    &Local::now(),
                ) {
                    Self::append_raw(home, &entry);
                }
            }
        }
    }

    /// 把已组装的记录实际追加到当天日文件（含顺带轮转）；
    /// 任何失败静默——日志故障不能反过来打挂应用
    fn append_raw(home: &Path, entry: &Value) {
        let dir = logs_dir(home);
        if fs_err_mkdir(&dir).is_err() {
            return;
        }
        // 每次写盘顺带轮转：错误日志频率很低，readdir 成本可忽略
        let mut entries: Vec<(String, u128)> = Vec::new();
        if let Ok(names) = std::fs::read_dir(&dir) {
            for name in names.flatten() {
                let file_name = name.file_name().to_string_lossy().into_owned();
                if !(file_name.starts_with("app-") && file_name.ends_with(".jsonl")) {
                    continue;
                }
                if let Ok(st) = name.metadata() {
                    let mtime = st
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    entries.push((file_name, mtime));
                }
            }
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        for stale in prune_log_files(&entries, now_ms) {
            let _ = std::fs::remove_file(dir.join(&stale));
        }
        let today = local_date(&Local::now());
        let line = format!("{}\n", entry);
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(log_file_name(&today)))
        {
            Ok(mut f) => {
                use std::io::Write as _;
                let _ = f.write_all(line.as_bytes());
            }
            Err(_) => {}
        }
    }

    /// 记录子进程（渲染器 / GPU / utility）消失事件
    #[allow(dead_code)] // 对齐 JS API；Tauri 侧暂无 child-process-gone 事件源，保留协议
    pub fn log_child_process_gone(
        &self,
        r#type: Option<&str>,
        reason: Option<&str>,
        exit_code: Option<f64>,
    ) {
        self.log(
            "error",
            "child-process",
            &format!(
                "{} 进程异常退出: {}",
                r#type.unwrap_or("unknown"),
                reason.unwrap_or("unknown")
            ),
            None,
            &LogMeta {
                reason,
                exit_code,
                ..Default::default()
            },
        );
    }

    /// 登记一枚本次启动新发现的原生崩溃 minidump
    pub fn log_native_crash(&self, dump_file: &str, size: Option<u64>) {
        self.log(
            "warn",
            "native-crash",
            &format!(
                "检测到上次运行留下的崩溃转储: {}（{} 字节）",
                dump_file,
                size.unwrap_or(0)
            ),
            None,
            &LogMeta {
                dump: Some(dump_file),
                ..Default::default()
            },
        );
    }
}

fn fs_err_mkdir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

// ---------- 进程级单例（panic hook 需在 state 之外可达） ----------

static LOGGER: OnceLock<Arc<Logger>> = OnceLock::new();

/// 初始化进程级日志器（setup 调用一次）；返回句柄供 managed state 复用
pub(crate) fn init_global(home: PathBuf) -> Arc<Logger> {
    let logger = Logger::new(home);
    let _ = LOGGER.set(Arc::clone(&logger));
    logger
}

/// 取进程级日志器（未初始化时 None——panic hook 里的防御）
pub(crate) fn global() -> Option<&'static Arc<Logger>> {
    LOGGER.get()
}

/// 安装 panic 钩子：panic 信息写入 'main' 来源日志后交还默认钩子
/// （对应 Electron 侧主进程 JS 异常统一写本地日志的能力）
pub(crate) fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(logger) = global() {
            let message = format!("panic: {}", info);
            logger.log("error", "main", &message, None, &LogMeta::default());
        }
        default_hook(info);
    }));
}

/// 启动扫描：把崩溃目录中未登记过的 minidump 写入日志并更新 .seen-dumps 清单
/// （Tauri 侧共享 ~/.tmd，可补记 Electron 版上次运行留下的崩溃线索）
pub(crate) fn scan_new_dumps(logger: &Logger, home: &Path) {
    let dump_dir = crash_dumps_dir(home);
    let dir = logs_dir(home);
    let seen_file = dir.join(".seen-dumps");

    let seen: Vec<String> = std::fs::read_to_string(&seen_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if !dump_dir.exists() {
        return; // 崩溃目录尚不存在：从未发生过原生崩溃
    }
    let files = collect_dump_files(&dump_dir, "");
    for name in list_new_dumps(&files, &seen) {
        let size = std::fs::metadata(dump_dir.join(&name))
            .ok()
            .map(|m| m.len());
        logger.log_native_crash(&name, size);
    }
    // 清单以崩溃目录现状为准（用户手动删掉 dump 后清单同步收敛）
    let _ = fs_err_mkdir(&dir);
    if let Ok(json) = serde_json::to_string_pretty(&files) {
        let _ = std::fs::write(seen_file, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_aged_and_excess_files() {
        let now: u128 = 1_000_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        let entries: Vec<(String, u128)> = (0..12)
            .map(|i| (format!("app-{}.jsonl", i), now - i * day / 2)) // 每 12 小时一个
            .collect();
        let to_delete = prune_log_files(&entries, now);
        // 7 天保留窗口内 = 14 个半天，全部未超龄；12 个 > 10 个 → 最旧 2 个删（i 大者更旧）
        assert_eq!(to_delete, vec!["app-11.jsonl", "app-10.jsonl"]);
        // 超龄：mtime 早于 7 天的全删
        let aged: Vec<(String, u128)> = vec![
            ("a.jsonl".into(), now - 8 * day),
            ("b.jsonl".into(), now - 6 * day),
        ];
        assert_eq!(prune_log_files(&aged, now), vec!["a.jsonl"]);
    }

    #[test]
    fn truncate_marks_overlong_fields() {
        let short = "短消息";
        assert_eq!(truncate_field(short), short);
        let long = "字".repeat(FIELD_MAX + 10);
        let out = truncate_field(&long);
        assert_eq!(
            out.chars().count(),
            FIELD_MAX + "…[truncated]".chars().count()
        );
        assert!(out.ends_with("…[truncated]"));
    }

    #[test]
    fn build_entry_whitelists_level_source_and_fields() {
        let now = Local::now();
        let meta = LogMeta {
            filename: Some("a.ts"),
            lineno: Some(12.0),
            colno: Some(f64::NAN), // 非有限 → 丢弃
            ..Default::default()
        };
        let entry =
            build_entry("error", "renderer", "出错了", Some("stack..."), &meta, &now).unwrap();
        assert_eq!(entry["level"], "error");
        assert!(entry.get("filename").is_some());
        assert!(entry.get("colno").is_none());
        // 非法级别 / 来源 / 空消息 → None
        assert!(build_entry("info", "renderer", "x", None, &meta, &now).is_none());
        assert!(build_entry("error", "hacker", "x", None, &meta, &now).is_none());
        assert!(build_entry("error", "renderer", "", None, &meta, &now).is_none());
    }

    #[test]
    fn normalize_renderer_report_drops_garbage() {
        let ok = normalize_renderer_report(&serde_json::json!({
            "message": " boom ", "stack": "s", "filename": "f", "lineno": 3, "colno": 4
        }))
        .unwrap();
        assert_eq!(ok.message, " boom "); // message 不 trim（与 JS 一致，仅截断）
        assert_eq!(ok.lineno, Some(3.0));
        assert!(normalize_renderer_report(&serde_json::json!({ "message": "" })).is_none());
        assert!(normalize_renderer_report(&serde_json::json!({ "stack": "s" })).is_none());
        assert!(normalize_renderer_report(&Value::Null).is_none());
    }

    #[test]
    fn dedup_window_counts_then_flushes_summary() {
        let home = std::env::temp_dir().join(format!("tmd-logger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let logger = Logger::new(home.clone());
        let base: u128 = 1_700_000_000_000;
        // 同消息 3 次（窗口内）→ 只落盘 1 条
        for i in 0..3 {
            logger.log_at(
                base + i * 1000,
                "error",
                "renderer",
                "重复错误",
                None,
                &LogMeta::default(),
            );
        }
        let dir = logs_dir(&home);
        let day_file = dir.join(log_file_name(&local_date(&Local::now())));
        let content = std::fs::read_to_string(&day_file).unwrap();
        assert_eq!(content.lines().count(), 1);
        // 窗口期满后任意一条新日志「顺带」冲刷出汇总行
        logger.log_at(
            base + DEDUP_WINDOW_MS + 1000,
            "warn",
            "main",
            "另一条日志",
            None,
            &LogMeta::default(),
        );
        let content = std::fs::read_to_string(&day_file).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3, "应有 2 条原始日志 + 1 条汇总：{:?}", lines);
        assert!(
            lines[1].contains("相同消息在 60 秒内重复 3 次"),
            "{:?}",
            lines[1]
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn dump_scan_marks_seen_and_logs_new_dumps() {
        let home = std::env::temp_dir().join(format!("tmd-logger-dumps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dumps = crash_dumps_dir(&home);
        std::fs::create_dir_all(dumps.join("pending")).unwrap();
        std::fs::write(dumps.join("pending").join("a.dmp"), b"x").unwrap();
        std::fs::write(dumps.join("b.dmp"), b"y").unwrap();
        std::fs::write(dumps.join("c.txt"), b"z").unwrap(); // 非 dmp 忽略
        let logger = Logger::new(home.clone());
        scan_new_dumps(&logger, &home);
        let seen_file = logs_dir(&home).join(".seen-dumps");
        let seen = std::fs::read_to_string(&seen_file).unwrap();
        assert!(seen.contains("pending/a.dmp") && seen.contains("b.dmp"));
        assert!(!seen.contains("c.txt"));
        // 第二次扫描：无新 dump，不再产生日志行
        let log_before = std::fs::read_to_string(
            logs_dir(&home).join(log_file_name(&local_date(&Local::now()))),
        )
        .unwrap()
        .lines()
        .count();
        scan_new_dumps(&logger, &home);
        let log_after = std::fs::read_to_string(
            logs_dir(&home).join(log_file_name(&local_date(&Local::now()))),
        )
        .unwrap()
        .lines()
        .count();
        assert_eq!(log_before, log_after);
        let _ = std::fs::remove_dir_all(home);
    }
}
