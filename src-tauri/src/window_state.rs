//! 窗口几何持久化（electron/shell-state.cjs 的窗口几何部分 Rust 移植）。
//!
//! 职责（全部围绕主窗口几何，不含菜单/最近列表等交互状态）：
//! - 位置尺寸最大化标记的记录：WinStateTracker 记「非最大化时的最近几何」
//!   （对应 getNormalBounds——最大化时记录的仍是还原后的几何），事件防抖 500ms 落盘；
//! - 启动恢复：restore_win_state 宽高钳制到最小值，最大化标记回放；
//! - 多显示器拔插/换机钳制：左上角不在任何显示器范围内时放弃位置恢复，
//!   交系统默认摆放（monitor_rects 提供逻辑坐标的显示器矩形）；
//! - 关闭前落盘：Destroyed 事件同步 save_now，退出路径上防抖异步写不保证
//!   执行完。
//!
//! 数据文件 userData/shell-state.json 亦存主题来源与自动更新开关，读写原语
//! （read_shell_state / save_shell_state）由本模块提供；壳层交互状态见 shell.rs。
//!
//! 已知缺口：显示器校验用 monitor 全尺寸近似 workArea（Tauri Monitor 无工作区
//! 概念，Dock/菜单栏遮挡的边缘场景坐标可能略偏）。
//!
//! @author chiangyang

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Monitor};

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
    // userData 目录不能假定存在：Windows 上 WebView2 首跑即建目录，macOS 的
    // WKWebView 数据落在 ~/Library/WebKit——Application Support/{identifier}
    // 只有这里会写，缺 create_dir_all 会让首次保存静默失败（几何/主题/更新
    // 开关全部不持久化，A5 验收抓到的真缺陷）
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
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
            // 转逻辑坐标：winState 存的是逻辑值（见 main.rs 几何记录注释），
            // 「左上角落在显示器内」的判定必须在同一坐标系
            let scale = m.scale_factor();
            let pos = m.position();
            let size = m.size();
            (
                (pos.x as f64 / scale).round() as i32,
                (pos.y as f64 / scale).round() as i32,
                (size.width as f64 / scale).round() as u32,
                (size.height as f64 / scale).round() as u32,
            )
        })
        .collect()
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
    fn tracker_records_normal_geometry_only() {
        let tracker = WinStateTracker::new(temp_file("tracker"));
        tracker.record(10, 20, 1000.0, 700.0, false);
        tracker.record(0, 0, 1920.0, 1080.0, true); // 最大化几何不覆盖 last_normal
        let geom = *tracker.last_normal.lock().unwrap();
        assert_eq!(geom, Some((10, 20, 1000.0, 700.0)));
        assert!(tracker.generation.load(AtomicOrdering::SeqCst) >= 2);
    }
}
