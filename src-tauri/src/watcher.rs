//! 外部修改监视（electron/filewatcher.cjs + dirwatcher.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐的语义（JS 版保留服务 Electron 壳，改动需两处同步）：
//! - 文件监视：渲染层全量同步「打开文件集合」（差量增删，上限 64），事件按路径
//!   防抖合并（200ms 固定窗口，首个事件起算、不刷新——与 JS `pending.has` 一致），
//!   触发后读盘比对 sha1 内容指纹（换行归一 CRLF→LF）：指纹未变（自身写入回声 /
//!   元数据噪声）→ 忽略；真变化 → 投递 change 并**重建 watcher**（rename 原子保存
//!   会令旧 watcher 随 inode 失效）；ENOENT → 投递 unlink（known 无基线则不投递）
//! - 自身写入过滤：保存命令在写盘完成后经 noteWrite 预登记新指纹，紧随其后的
//!   文件事件按指纹比对自然被过滤
//! - 目录监视：全量同步「已加载目录集合」（上限 256），非递归一层，事件按目录
//!   防抖合并后回调目录绝对路径；内容变化不归本模块
//! - 尽力而为：任何监视/读取错误不上抛，绝不影响打开/保存主流程
//!
//! spike 简化：文件被删除后又在原路径重建，不自动恢复跟踪（等渲染层下次 sync
//! 重新挂上）——与 JS 版已知边界一致。

use crate::text_file::decode;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// 事件名（Tauri 事件名仅允许小写字母数字与 - / : _，与 Electron 通道名不同名）
pub(crate) const EVENT_FILE_CHANGED: &str = "tmd-file-changed";
pub(crate) const EVENT_DIRS_CHANGED: &str = "tmd-dirs-changed";

const DEBOUNCE: Duration = Duration::from_millis(200);
const MAX_FILE_WATCHERS: usize = 64;
const MAX_DIR_WATCHERS: usize = 256;
/// 消费线程的轮询间隔（决定防抖到期的检查精度）
const TICK: Duration = Duration::from_millis(20);

#[derive(Serialize, Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FileChangeKind {
    Change,
    Unlink,
}

#[derive(Serialize, Clone, Debug, Deserialize)]
pub(crate) struct FileChangeInfo {
    pub path: String,
    pub kind: FileChangeKind,
}

/// 事件投递函数（真实实现 = Tauri emit；测试注入收集器，脱壳单测状态机）
pub(crate) type EmitFn = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;

fn sha1_hex(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 换行归一：CRLF / 独立 CR 都按 LF 比较（与 JS normalizeEol 等价）
fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

struct Inner {
    watcher: Option<notify::RecommendedWatcher>,
    files: HashSet<String>,
    dirs: HashSet<String>,
    /// 路径 → 最近一次已知磁盘内容指纹（noteWrite 与投递 change 时推进）
    known: HashMap<String, String>,
    file_deadlines: HashMap<String, Instant>,
    dir_deadlines: HashMap<String, Instant>,
}

impl Inner {
    /// 固定窗口防抖：已有 deadline 不刷新（与 JS `pending.has(path) && return` 一致）
    fn schedule(deadlines: &mut HashMap<String, Instant>, key: &str) {
        deadlines
            .entry(key.to_string())
            .or_insert_with(|| Instant::now() + DEBOUNCE);
    }

    fn detach_file(&mut self, path: &str) {
        if let Some(w) = self.watcher.as_mut() {
            let _ = w.unwatch(Path::new(path));
        }
        self.files.remove(path);
        self.known.remove(path);
        self.file_deadlines.remove(path);
    }

    fn attach_file(&mut self, path: &str, emit: &EmitFn) {
        if let Some(w) = self.watcher.as_mut() {
            if let Err(_err) = w.watch(Path::new(path), RecursiveMode::NonRecursive) {
                // ENOENT：文件在挂载时已不存在 → 投递 unlink（known 无基线时
                // 后续 inspect 不会再投，天然去重）；其他失败静默
                if fs::metadata(path).is_err() {
                    emit(
                        EVENT_FILE_CHANGED,
                        serde_json::to_value(FileChangeInfo {
                            path: path.to_string(),
                            kind: FileChangeKind::Unlink,
                        })
                        .expect("FileChangeInfo 序列化失败"),
                    );
                }
            }
        }
    }

    /// 全量同步文件监视集合：差量增删，已监视路径的指纹基线保持不动。
    fn sync_files(&mut self, paths: Vec<String>, emit: &EmitFn) {
        let mut want: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for p in paths {
            if !p.is_empty() && seen.insert(p.clone()) {
                want.push(p);
                if want.len() >= MAX_FILE_WATCHERS {
                    break;
                }
            }
        }
        let want_set: HashSet<String> = want.iter().cloned().collect();
        for p in &want {
            if self.files.contains(p) {
                continue;
            }
            self.files.insert(p.clone());
            self.attach_file(p, emit);
            // 建立内容基线（JS 为异步读、基线落定前至多多通知一次；这里同步读无窗口）
            if let Ok(bytes) = fs::read(p) {
                let (_, _, content) = decode(&bytes);
                self.known.insert(p.clone(), sha1_hex(&normalize_eol(&content)));
            }
        }
        let stale: Vec<String> = self
            .files
            .iter()
            .filter(|p| !want_set.contains(*p))
            .cloned()
            .collect();
        for p in stale {
            self.detach_file(&p);
        }
    }

    fn sync_dirs(&mut self, paths: Vec<String>) {
        let mut want: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for p in paths {
            if !p.is_empty() && seen.insert(p.clone()) {
                want.push(p);
                if want.len() >= MAX_DIR_WATCHERS {
                    break;
                }
            }
        }
        let want_set: HashSet<String> = want.iter().cloned().collect();
        for p in want {
            if self.dirs.contains(&p) {
                continue;
            }
            self.dirs.insert(p.clone());
            if let Some(w) = self.watcher.as_mut() {
                // 目录删除 / 权限变化由后续事件与渲染层下次 sync 对齐（尽力而为）
                let _ = w.watch(Path::new(&p), RecursiveMode::NonRecursive);
            }
        }
        let stale: Vec<String> = self
            .dirs
            .iter()
            .filter(|p| !want_set.contains(*p))
            .cloned()
            .collect();
        for p in stale {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(Path::new(&p));
            }
            self.dirs.remove(&p);
            self.dir_deadlines.remove(&p);
        }
    }

    /// 登记一次自身写入的新指纹：仅已监视路径登记，避免无界增长。
    fn note_write(&mut self, path: &str, content: &str) {
        if self.files.contains(path) {
            self.known.insert(path.to_string(), sha1_hex(&normalize_eol(content)));
        }
    }

    /// 读盘并比对指纹：ENOENT → unlink（有基线才投递）；指纹未变 → 忽略；
    /// 真变化 → 投递 change 并重建 watcher（rename 原子保存令旧 watcher 失效）。
    fn inspect_file(&mut self, path: &str, emit: &EmitFn) {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if self.known.remove(path).is_some() {
                    self.detach_file(path);
                    emit(
                        EVENT_FILE_CHANGED,
                        serde_json::to_value(FileChangeInfo {
                            path: path.to_string(),
                            kind: FileChangeKind::Unlink,
                        })
                        .expect("FileChangeInfo 序列化失败"),
                    );
                }
                return;
            }
            Err(_) => return, // 权限等瞬时错误：保留现状，等下一次事件再试
        };
        let (_, _, content) = decode(&bytes);
        let hash = sha1_hex(&normalize_eol(&content));
        if self.known.get(path).is_some_and(|h| *h == hash) {
            return;
        }
        emit(
            EVENT_FILE_CHANGED,
            serde_json::to_value(FileChangeInfo {
                path: path.to_string(),
                kind: FileChangeKind::Change,
            })
            .expect("FileChangeInfo 序列化失败"),
        );
        // rename 替换后旧 watcher 可能已随 inode 失效：关闭重建
        if let Some(w) = self.watcher.as_mut() {
            let _ = w.unwatch(Path::new(path));
            let _ = w.watch(Path::new(path), RecursiveMode::NonRecursive);
        }
        self.known.insert(path.to_string(), hash);
    }

    /// notify 事件 → 防抖调度：命中已监视文件或目录才调度，其余忽略。
    fn handle_event(&mut self, event: notify::Event) {
        for path in event.paths {
            let p = path.to_string_lossy().into_owned();
            if self.files.contains(&p) {
                Self::schedule(&mut self.file_deadlines, &p);
            } else if self.dirs.contains(&p) {
                // 目录自身被删除 / 改名等
                Self::schedule(&mut self.dir_deadlines, &p);
            } else if let Some(parent) = Path::new(&p).parent() {
                let ps = parent.to_string_lossy().into_owned();
                if self.dirs.contains(&ps) {
                    // 目录内子项增删改名 → 该目录变化
                    Self::schedule(&mut self.dir_deadlines, &ps);
                }
            }
        }
    }

    /// 投递到期的防抖任务：文件走 inspect（指纹比对），目录直接回调。
    fn flush_due(&mut self, emit: &EmitFn) {
        let now = Instant::now();
        let due_files: Vec<String> = self
            .file_deadlines
            .iter()
            .filter(|(_, d)| **d <= now)
            .map(|(p, _)| p.clone())
            .collect();
        for p in &due_files {
            self.file_deadlines.remove(p);
            self.inspect_file(p, emit);
        }
        let due_dirs: Vec<String> = self
            .dir_deadlines
            .iter()
            .filter(|(_, d)| **d <= now)
            .map(|(p, _)| p.clone())
            .collect();
        for d in &due_dirs {
            self.dir_deadlines.remove(d);
            emit(EVENT_DIRS_CHANGED, serde_json::Value::String(d.clone()));
        }
    }
}

pub(crate) struct WatchState {
    inner: Arc<Mutex<Inner>>,
    emit: EmitFn,
}

impl WatchState {
    /// 真实构造：notify watcher + 消费线程 + Tauri emit。
    pub fn new(app: tauri::AppHandle) -> Self {
        let emit: EmitFn = Arc::new(move |name, payload| {
            let _ = app.emit(name, payload);
        });
        Self::with_emit(emit)
    }

    fn with_emit(emit: EmitFn) -> Self {
        let (tx, rx) = mpsc::channel::<Result<notify::Event, notify::Error>>();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .expect("notify watcher 创建失败");
        let inner = Arc::new(Mutex::new(Inner {
            watcher: Some(watcher),
            files: HashSet::new(),
            dirs: HashSet::new(),
            known: HashMap::new(),
            file_deadlines: HashMap::new(),
            dir_deadlines: HashMap::new(),
        }));
        // 消费线程：事件进防抖表，20ms tick 冲刷到期任务（防抖 200ms 固定窗口）
        let thread_inner = Arc::clone(&inner);
        let thread_emit = Arc::clone(&emit);
        std::thread::Builder::new()
            .name("tmd-watch".into())
            .spawn(move || loop {
                match rx.recv_timeout(TICK) {
                    Ok(Ok(event)) => {
                        if let Ok(mut g) = thread_inner.lock() {
                            g.handle_event(event);
                            g.flush_due(&thread_emit);
                        }
                    }
                    Ok(Err(_)) => {} // notify 平台错误：尽力而为，忽略
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Ok(mut g) = thread_inner.lock() {
                            g.flush_due(&thread_emit);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            })
            .expect("tmd-watch 线程启动失败");
        WatchState { inner, emit }
    }

    /// 渲染层全量同步「打开文件集合」（native.ts watchFiles）
    pub fn sync_files(&self, paths: Vec<String>) {
        if let Ok(mut g) = self.inner.lock() {
            g.sync_files(paths, &self.emit);
        }
    }

    /// 渲染层全量同步「已加载目录集合」（native.ts watchDirs）
    pub fn sync_dirs(&self, paths: Vec<String>) {
        if let Ok(mut g) = self.inner.lock() {
            g.sync_dirs(paths);
        }
    }

    /// 保存命令写盘完成后登记新指纹（过滤自身写入回声）
    pub fn note_write(&self, path: &str, content: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.note_write(path, content);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "tmd-spike-watch-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    /// 计数收集器：记录文件事件与目录事件
    struct Collector {
        file_events: Mutex<Vec<(String, FileChangeKind)>>,
        dir_events: Mutex<Vec<String>>,
        file_count: AtomicUsize,
        dir_count: AtomicUsize,
    }

    impl Collector {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                file_events: Mutex::new(Vec::new()),
                dir_events: Mutex::new(Vec::new()),
                file_count: AtomicUsize::new(0),
                dir_count: AtomicUsize::new(0),
            })
        }
        fn emit_state(self: &Arc<Self>) -> WatchState {
            let c = Arc::clone(self);
            WatchState::with_emit(Arc::new(move |name, payload| {
                if name == EVENT_FILE_CHANGED {
                    let info: FileChangeInfo = serde_json::from_value(payload).unwrap();
                    c.file_count.fetch_add(1, Ordering::SeqCst);
                    c.file_events.lock().unwrap().push((info.path, info.kind));
                } else if name == EVENT_DIRS_CHANGED {
                    let dir: String = serde_json::from_value(payload).unwrap();
                    c.dir_count.fetch_add(1, Ordering::SeqCst);
                    c.dir_events.lock().unwrap().push(dir);
                }
            }))
        }
    }

    #[test]
    fn normalize_eol_matches_js() {
        assert_eq!(normalize_eol("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert_eq!(normalize_eol("plain"), "plain");
    }

    #[test]
    fn self_write_echo_is_filtered_by_fingerprint() {
        let root = temp_dir("echo");
        let f = format!("{}/a.md", root);
        fs::write(&f, "v1\n").unwrap();
        let c = Collector::new();
        let state = c.emit_state();
        state.sync_files(vec![f.clone()]);
        // 自身写入：先登记新指纹，再写盘，事件到达按指纹比对被过滤
        state.note_write(&f, "v2\n");
        fs::write(&f, "v2\n").unwrap();
        if let Ok(mut g) = state.inner.lock() {
            g.inspect_file(&f, &state.emit);
        }
        assert_eq!(c.file_count.load(Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_change_emits_once_and_rebaselines() {
        let root = temp_dir("change");
        let f = format!("{}/a.md", root);
        fs::write(&f, "v1\n").unwrap();
        let c = Collector::new();
        let state = c.emit_state();
        state.sync_files(vec![f.clone()]);
        fs::write(&f, "外部修改\n").unwrap();
        if let Ok(mut g) = state.inner.lock() {
            g.inspect_file(&f, &state.emit);
            // 基线已推进：同一内容再查不重复投递
            g.inspect_file(&f, &state.emit);
        }
        assert_eq!(c.file_count.load(Ordering::SeqCst), 1);
        let events = c.file_events.lock().unwrap();
        assert_eq!(events[0].1, FileChangeKind::Change);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_emits_unlink_once() {
        let root = temp_dir("unlink");
        let f = format!("{}/a.md", root);
        fs::write(&f, "v1\n").unwrap();
        let c = Collector::new();
        let state = c.emit_state();
        state.sync_files(vec![f.clone()]);
        fs::remove_file(&f).unwrap();
        if let Ok(mut g) = state.inner.lock() {
            g.inspect_file(&f, &state.emit);
            g.inspect_file(&f, &state.emit); // 第二次无基线，不重复投递
        }
        assert_eq!(c.file_count.load(Ordering::SeqCst), 1);
        let events = c.file_events.lock().unwrap();
        assert_eq!(events[0].1, FileChangeKind::Unlink);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_diffs_watch_set_and_caps() {
        let root = temp_dir("sync");
        let mut paths = Vec::new();
        for i in 0..3 {
            let p = format!("{}/n{}.md", root, i);
            fs::write(&p, "x\n").unwrap();
            paths.push(p);
        }
        let c = Collector::new();
        let state = c.emit_state();
        state.sync_files(paths.clone());
        {
            let g = state.inner.lock().unwrap();
            assert_eq!(g.files.len(), 3);
            assert!(g.known.contains_key(&paths[0]));
        }
        // 差量：移除 n0/n1，保留 n2 的基线
        state.sync_files(vec![paths[2].clone()]);
        {
            let g = state.inner.lock().unwrap();
            assert_eq!(g.files.len(), 1);
            assert!(g.known.contains_key(&paths[2]));
        }
        // 上限 64：异常载荷兜底
        let flood: Vec<String> = (0..100).map(|i| format!("{}/f{}.md", root, i)).collect();
        state.sync_files(flood);
        {
            let g = state.inner.lock().unwrap();
            assert_eq!(g.files.len(), MAX_FILE_WATCHERS);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dir_events_debounce_to_single_emit() {
        let root = temp_dir("dir");
        let dir = format!("{}/notebook", root);
        fs::create_dir_all(&dir).unwrap();
        let c = Collector::new();
        let state = c.emit_state();
        state.sync_dirs(vec![dir.clone()]);
        if let Ok(mut g) = state.inner.lock() {
            // 一次外部操作常派发多个事件：全部落在同一固定窗口 → 只投递一次
            g.handle_event(notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                .add_path(PathBuf::from(format!("{}/new.md", dir))));
            g.handle_event(notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
                .add_path(PathBuf::from(format!("{}/new.md", dir))));
            assert!(g.dir_deadlines.contains_key(&dir));
            std::thread::sleep(DEBOUNCE + Duration::from_millis(30));
            g.flush_due(&state.emit);
        }
        assert_eq!(c.dir_count.load(Ordering::SeqCst), 1);
        assert_eq!(*c.dir_events.lock().unwrap().first().unwrap(), dir);
        let _ = fs::remove_dir_all(root);
    }
}
