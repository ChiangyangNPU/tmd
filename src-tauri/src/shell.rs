//! 壳层可变状态（electron/app-state.cjs + recent.cjs + menu 装配的 Rust 合并）。
//!
//! 权威状态：菜单文案 / 自定义快捷键 / 最近文件 / 自动保存开关 / 脏标记 /
//! 排序区域。语言切换、快捷键同步、最近列表变化后由本模块重建菜单
//! （与 main.cjs 的 buildMenu() 触发链一致）。
//!
//! spike 已知缺口：
//! - 系统最近文档注册（Windows Jump List / macOS Dock）无 Tauri 对应 API，
//!   仅维护菜单子菜单的镜像列表
//! - shell-state.json 持久化（主题来源 / 窗口几何）未迁移，重启回落默认

use crate::menu::{build_menu, collation_locale, default_labels, RecentEntry};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Wry};

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
    pub fn set_locale_info(&self, app: &AppHandle, labels: HashMap<String, String>, locale: &str) -> String {
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

    pub fn recent_clear(&self, app: &AppHandle) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents.clear();
        }
        self.rebuild_menu(app);
    }

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
        if let Some(item) = self.autosave_item.lock().expect("autosave item 锁中毒").as_ref() {
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

    pub fn set_dirty(&self, dirty: bool) {
        self.inner.lock().expect("shell state 中毒").dirty = dirty;
    }

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
