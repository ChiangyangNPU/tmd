//! 壳层可变状态（electron/app-state.cjs + recent.cjs + menu 装配的 Rust 合并）。
//!
//! 权威状态：菜单文案 / 自定义快捷键 / 最近文件 / 自动保存开关 / 脏标记 /
//! 排序区域。语言切换、快捷键同步、最近列表变化后由本模块重建菜单
//! （与 main.cjs 的 buildMenu() 触发链一致）。
//!
//! 另含壳层持久化状态（electron/shell-state.cjs 的 Rust 移植）：
//! userData/shell-state.json 存主题来源与窗口几何（宽高钳制 + 显示器校验 +
//! 最大化标记），启动时在窗口创建前恢复使首帧即正确。
//!
//! spike 已知缺口：
//! - 系统最近文档注册（Windows Jump List / macOS Dock）无 Tauri 对应 API，
//!   仅维护菜单子菜单的镜像列表
//! - 显示器校验用 monitor 全尺寸近似 workArea（Tauri Monitor 无工作区概念，
//!   Dock/菜单栏遮挡的边缘场景坐标可能略偏）
//!
//! @author chiangyang

use crate::menu::{build_menu, collation_locale, default_labels, RecentEntry};
use pinyin::ToPinyin;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};

pub(crate) struct ShellState {
    inner: Mutex<ShellInner>,
    /// 自动保存 checkbox 句柄：菜单点击时回读状态、设置面板同步时回写（对应 autosaveMenuItem）
    autosave_item: Mutex<Option<tauri::menu::CheckMenuItem<Wry>>>,
}

struct ShellInner {
    labels: HashMap<String, String>,
    shortcuts: HashMap<String, String>,
    recents: Vec<RecentEntry>,
    autosave_enabled: bool,
    dirty: bool,
    sort_locale: String,
}

impl ShellState {
    /// 创建壳状态（菜单文案取中文默认，其余为空/默认值）
    pub fn new() -> Self {
        ShellState {
            inner: Mutex::new(ShellInner {
                labels: default_labels(),
                shortcuts: HashMap::new(),
                recents: Vec::new(),
                autosave_enabled: false,
                dirty: false,
                sort_locale: String::new(),
            }),
            autosave_item: Mutex::new(None),
        }
    }

    /// 重建应用菜单（触发链与 main.cjs buildMenu() 一致：语言切换 / 快捷键
    /// 同步 / 最近列表变化后调用）。启动时以中文默认文案建一次。
    pub fn rebuild_menu(&self, app: &AppHandle) {
        let (labels, shortcuts, recents, autosave) = {
            let g = self.inner.lock().expect("shell state 中毒");
            (
                g.labels.clone(),
                g.shortcuts.clone(),
                g.recents.clone(),
                g.autosave_enabled,
            )
        };
        match build_menu(app, &labels, &shortcuts, &recents, autosave) {
            Ok(built) => {
                if let Err(err) = app.set_menu(built.menu.clone()) {
                    eprintln!("[tmd-tauri] 菜单设置失败: {}", err);
                }
                *self.autosave_item.lock().expect("autosave item 锁中毒") = Some(built.autosave);
            }
            Err(err) => eprintln!("[tmd-tauri] 菜单构建失败: {}", err),
        }
    }

    /// 渲染层下发语言包：合并中文兜底后重建菜单；返回映射后的排序区域。
    pub fn set_locale_info(
        &self,
        app: &AppHandle,
        labels: HashMap<String, String>,
        locale: &str,
    ) -> String {
        let mapped = {
            let mut g = self.inner.lock().expect("shell state 中毒");
            let mut merged = default_labels();
            for (k, v) in labels {
                merged.insert(k, v);
            }
            g.labels = merged;
            if !locale.is_empty() {
                g.sort_locale = collation_locale(&locale);
            }
            g.sort_locale.clone()
        };
        self.rebuild_menu(app);
        mapped
    }

    /// 对应 native.ts syncShortcuts：更新 accelerator 表并重建菜单
    pub fn sync_shortcuts(&self, app: &AppHandle, shortcuts: HashMap<String, String>) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.shortcuts = shortcuts;
        }
        self.rebuild_menu(app);
    }

    /// 全量同步最近列表（渲染层启动时；只重建菜单，不触碰系统最近文档）
    pub fn recent_sync(&self, app: &AppHandle, entries: Vec<RecentEntry>) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents = normalize_recent(entries);
        }
        self.rebuild_menu(app);
    }

    /// 新增/打开：镜像列表去重置顶（限量 8，与 recent.cjs 一致）后重建菜单
    pub fn recent_add(&self, app: &AppHandle, entry: RecentEntry) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            let mut normalized = normalize_recent(vec![entry]);
            if normalized.is_empty() {
                return;
            }
            let first = normalized.remove(0);
            let mut recents = Vec::with_capacity(9);
            recents.push(first);
            let previous = std::mem::take(&mut g.recents);
            for r in previous {
                if r.path != recents[0].path {
                    recents.push(r);
                }
            }
            recents.truncate(8);
            g.recents = recents;
        }
        self.rebuild_menu(app);
    }

    /// 对应 native.ts recentClear：清空镜像列表并重建菜单
    pub fn recent_clear(&self, app: &AppHandle) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents.clear();
        }
        self.rebuild_menu(app);
    }

    /// 对应 native.ts recentRemove：单条移除并重建菜单
    pub fn recent_remove(&self, app: &AppHandle, path: &str) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents.retain(|r| r.path != path);
        }
        self.rebuild_menu(app);
    }

    /// 设置面板同步自动保存开关（保持菜单勾选状态一致）
    pub fn set_autosave_enabled(&self, enabled: bool) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.autosave_enabled = enabled;
        }
        if let Some(item) = self
            .autosave_item
            .lock()
            .expect("autosave item 锁中毒")
            .as_ref()
        {
            let _ = item.set_checked(enabled);
        }
    }

    /// 自动保存 checkbox 被点击后的当前状态（muda 已自动翻转）
    pub fn autosave_checked_after_click(&self) -> Option<bool> {
        self.autosave_item
            .lock()
            .expect("autosave item 锁中毒")
            .as_ref()
            .and_then(|item| item.is_checked().ok())
    }

    /// 对应 native.ts setDirty：渲染层同步未保存状态（关闭确认用）
    pub fn set_dirty(&self, dirty: bool) {
        self.inner.lock().expect("shell state 中毒").dirty = dirty;
    }

    /// 当前排序区域（setLocaleInfo 设置；空串表示未同步，调用方按码点排序）
    pub fn sort_locale(&self) -> String {
        self.inner.lock().expect("shell state 中毒").sort_locale.clone()
    }

    /// 关闭确认时查询脏标记
    pub fn is_dirty(&self) -> bool {
        self.inner.lock().expect("shell state 中毒").dirty
    }
}

fn normalize_recent(entries: Vec<RecentEntry>) -> Vec<RecentEntry> {
    let mut seen = std::collections::HashSet::new();
    entries
        .into_iter()
        .filter(|e| !e.path.is_empty() && !e.name.is_empty() && seen.insert(e.path.clone()))
        .collect()
}

// ---------- 壳层持久化（electron/shell-state.cjs 的 Rust 移植） ----------

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use tauri::Monitor;

/// 恢复窗口几何时的最小宽高（与 JS 版一致）
const MIN_RESTORE_WIDTH: f64 = 860.0;
const MIN_RESTORE_HEIGHT: f64 = 560.0;

/// 读取壳层持久化状态；文件缺失/损坏静默返回空对象
pub(crate) fn read_shell_state(path: &std::path::Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 增量写入壳层持久化状态（merge + 临时文件原子替换；失败静默清残留）
pub(crate) fn save_shell_state(path: &std::path::Path, patch: Value) {
    let mut state = read_shell_state(path);
    if let (Some(obj), Some(patch_obj)) = (state.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    let tmp = path.with_extension("json.tmp");
    match serde_json::to_string_pretty(&state) {
        Ok(json) => {
            if std::fs::write(&tmp, json)
                .and_then(|_| std::fs::rename(&tmp, path))
                .is_err()
            {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// 恢复窗口几何：宽高钳制到最小值；仅当左上角落在某个显示器范围内才恢复
/// 位置（显示器拔插/换机后旧坐标可能悬空）。无记录或字段不合法 → None。
/// display_rects 由调用方注入（tauri available_monitors / 测试注入）。
pub(crate) fn restore_win_state(
    state: &Value,
    display_rects: &[(i32, i32, u32, u32)],
) -> Option<RestoredWin> {
    let s = state.get("winState")?;
    let num = |v: Option<&Value>| -> Option<f64> {
        v.and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| n.round())
    };
    let width = num(s.get("width"))?;
    let height = num(s.get("height"))?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    let mut out = RestoredWin {
        width: width.max(MIN_RESTORE_WIDTH),
        height: height.max(MIN_RESTORE_HEIGHT),
        x: None,
        y: None,
        maximized: s.get("maximized").and_then(Value::as_bool).unwrap_or(false),
    };
    let (Some(x), Some(y)) = (num(s.get("x")), num(s.get("y"))) else {
        return Some(out);
    };
    // 左上角落在任一显示器范围内才恢复位置
    let (xi, yi) = (x as i32, y as i32);
    let on_screen = display_rects.iter().any(|(mx, my, mw, mh)| {
        xi >= *mx && xi < *mx + *mw as i32 && yi >= *my && yi < *my + *mh as i32
    });
    if on_screen {
        out.x = Some(xi);
        out.y = Some(yi);
    }
    Some(out)
}

/// 恢复出的窗口几何（宽高已钳制；位置仅在显示器范围内才携带）
#[derive(Clone, Copy, Debug)]
pub(crate) struct RestoredWin {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
}

/// 从 tauri 显示器列表提取 (x, y, w, h)（restore_win_state 的注入形）
pub(crate) fn monitor_rects(monitors: &[Monitor]) -> Vec<(i32, i32, u32, u32)> {
    monitors
        .iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            (pos.x, pos.y, size.width, size.height)
        })
        .collect()
}

/// locale 感知的名称排序键（对应 JS `name.localeCompare(name, locale)` 的
/// Rust 近似）：zh-CN 按汉字全拼排序（pinyin crate）；zh-TW 的 ICU 注音/笔画序
/// 在 Rust 侧不可达，**降级为同 zh-CN 拼音序**（已记录的已知差异）；其他
/// locale 原样按码点排序。非汉字字符原样保留，天然支持中英混排。
pub(crate) fn sort_key(name: &str, locale: &str) -> String {
    match locale {
        "zh-CN" | "zh-TW" => {
            let mut key = String::with_capacity(name.len() * 2);
            for (ch, pinyin) in name.chars().zip(name.to_pinyin()) {
                match pinyin {
                    Some(p) => key.push_str(p.plain()),
                    None => key.push(ch),
                }
            }
            key
        }
        _ => name.to_string(),
    }
}

/// 窗口几何持久化追踪器：记录「非最大化时的最近几何」（对应
/// getNormalBounds——最大化时记录的仍是还原后的几何），防抖 500ms 落盘。
pub(crate) struct WinStateTracker {
    pub path: std::path::PathBuf,
    /// 防抖代数：每次事件 +1，落盘线程醒来时代数未变才写
    pub generation: AtomicU64,
    /// 最近一次非最大化几何 (x, y, width, height)
    pub last_normal: Mutex<Option<(i32, i32, f64, f64)>>,
}

impl WinStateTracker {
    pub fn new(path: std::path::PathBuf) -> Self {
        WinStateTracker {
            path,
            generation: AtomicU64::new(0),
            last_normal: Mutex::new(None),
        }
    }

    /// 记录一次几何事件：非最大化时更新 last_normal（调用方负责调度防抖落盘）
    pub fn record(&self, x: i32, y: i32, width: f64, height: f64, maximized: bool) {
        if !maximized {
            *self.last_normal.lock().expect("win tracker 锁中毒") = Some((x, y, width, height));
        }
        self.generation.fetch_add(1, AtomicOrdering::SeqCst);
    }

    /// 落盘当前 winState（last_normal 缺失时跳过——首帧即最大化且无历史几何）
    pub fn save_now(&self, app: &AppHandle) {
        let maximized = app
            .get_webview_window("main")
            .and_then(|w| w.is_maximized().ok())
            .unwrap_or(false);
        let geom = *self.last_normal.lock().expect("win tracker 锁中毒");
        let Some((x, y, width, height)) = geom else {
            return;
        };
        save_shell_state(
            &self.path,
            serde_json::json!({
                "winState": { "x": x, "y": y, "width": width, "height": height, "maximized": maximized }
            }),
        );
    }
}

#[cfg(test)]
mod persist_tests {
    use super::*;

    fn temp_file(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tmd-shell-state-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("shell-state.json")
    }

    #[test]
    fn save_read_roundtrip_merges_patches() {
        let path = temp_file("merge");
        save_shell_state(&path, serde_json::json!({ "themeSource": "dark" }));
        save_shell_state(
            &path,
            serde_json::json!({ "winState": { "width": 1000, "height": 700 } }),
        );
        let state = read_shell_state(&path);
        assert_eq!(state["themeSource"], "dark");
        assert_eq!(state["winState"]["width"], 1000);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn restore_clamps_size_and_validates_position() {
        // 尺寸钳制 + 屏内位置恢复 + 最大化标记
        let state = serde_json::json!({
            "winState": { "width": 500, "height": 400, "x": 100, "y": 100, "maximized": true }
        });
        let displays = vec![(0, 0, 1920u32, 1080u32)];
        let win = restore_win_state(&state, &displays).unwrap();
        assert_eq!(win.width, 860.0);
        assert_eq!(win.height, 560.0);
        assert_eq!(win.x, Some(100));
        assert!(win.maximized);
        // 悬空位置（显示器拔插/换机）→ 不带 x/y，交系统默认摆放
        let dangling = serde_json::json!({
            "winState": { "width": 1000, "height": 700, "x": 99999, "y": 99999 }
        });
        let win = restore_win_state(&dangling, &displays).unwrap();
        assert_eq!(win.x, None);
        // 无记录 → None
        assert!(restore_win_state(&serde_json::json!({}), &displays).is_none());
        // 缺位置字段 → 尺寸照常恢复
        let no_pos = serde_json::json!({ "winState": { "width": 1000, "height": 700 } });
        let win = restore_win_state(&no_pos, &displays).unwrap();
        assert_eq!(win.x, None);
        assert_eq!(win.width, 1000.0);
    }

    #[test]
    fn sort_key_orders_chinese_by_pinyin() {
        // 区分度用例：北(bei, U+5317) 与 阿(a, U+963F)——拼音序 阿<北，
        // 码点序恰好相反，两种排序可判然区分
        let mut names = vec!["北", "阿", "English", "123"];
        names.sort_by_key(|n| sort_key(n, "zh-CN"));
        assert_eq!(names, vec!["123", "English", "阿", "北"]);
        // 非 zh locale：原样码点序（北 U+5317 < 阿 U+963F）
        let mut names = vec!["北", "阿"];
        names.sort_by_key(|n| sort_key(n, "en"));
        assert_eq!(names, vec!["北", "阿"]);
        // zh-TW 降级为拼音序（与 zh-CN 同键）
        assert_eq!(sort_key("北", "zh-TW"), sort_key("北", "zh-CN"));
    }

    #[test]
    fn tracker_records_normal_geometry_only() {
        let tracker = WinStateTracker::new(temp_file("tracker"));
        tracker.record(10, 20, 1000.0, 700.0, false);
        tracker.record(0, 0, 1920.0, 1080.0, true); // 最大化几何不覆盖 last_normal
        let geom = *tracker.last_normal.lock().unwrap();
        assert_eq!(geom, Some((10, 20, 1000.0, 700.0)));
        assert!(tracker.generation.load(AtomicOrdering::SeqCst) >= 2);
    }
}
