//! 壳层交互状态（electron/app-state.cjs + recent.cjs + menu 装配的 Rust 合并）。
//!
//! 权威状态：菜单文案 / 自定义快捷键 / 最近文件 / 自动保存开关 / 脏标记 /
//! 排序区域。语言切换、快捷键同步、最近列表变化后由本模块重建菜单
//! （与 main.cjs 的 buildMenu() 触发链一致）。
//!
//! 窗口几何持久化（位置尺寸最大化记录、启动恢复、多显示器钳制、关闭前落盘）
//! 已拆到 window_state.rs；shell-state.json 的读写原语也随之下沉，本模块不再
//! 承担窗口几何职责。
//!
//! spike 已知缺口：
//! - 系统最近文档注册（Windows Jump List / macOS Dock）无 Tauri 对应 API，
//!   仅维护菜单子菜单的镜像列表
//!
//! @author chiangyang

// build_menu 仅 macOS 实挂菜单时使用（Windows 不挂原生菜单，见 rebuild_menu）
#[cfg(target_os = "macos")]
use crate::menu::build_menu;
use crate::menu::{collation_locale, RecentEntry};
use pinyin::ToPinyin;
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
    /// 创建壳状态（菜单文案取中文默认，其余为空/默认值）
    pub fn new() -> Self {
        ShellState {
            inner: Mutex::new(ShellInner {
                labels: HashMap::new(),
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
    /// 仅 macOS 实挂：Windows 挂原生菜单会在首帧闪菜单栏且偏离 Electron
    /// 观感（Electron 版 Win/Linux 隐藏菜单栏、快捷键走渲染层 keydown 兜底
    /// 分发），故 Windows 侧本函数为 no-op，快捷键由渲染层 keydown 承担。
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn rebuild_menu(&self, app: &AppHandle) {
        #[cfg(target_os = "macos")]
        {
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
                    *self.autosave_item.lock().expect("autosave item 锁中毒") =
                        Some(built.autosave);
                }
                Err(err) => eprintln!("[tmd-tauri] 菜单构建失败: {}", err),
            }
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
            // 文案单源在渲染层：直接采用传入的整表，不再本地兜底合并——
            // 覆盖性由 src/__tests__/menu-labels.test.ts 对 menu.rs 的 l("key")
            // 扫描保证；缺键时菜单显示 key 本身，属于显性失败而非静默中文
            g.labels = labels;
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
        let added = {
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
            let added = recents[0].path.clone();
            g.recents = recents;
            added
        };
        self.rebuild_menu(app);
        // 系统最近文档与菜单镜像同步登记（macOS Dock 右键「最近使用」）；
        // NSDocumentController 只能在主线程调用，故经事件循环调度
        let _ = app.run_on_main_thread(move || crate::recent::note(&added));
    }

    /// 对应 native.ts recentClear：清空镜像列表并重建菜单
    pub fn recent_clear(&self, app: &AppHandle) {
        {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents.clear();
        }
        self.rebuild_menu(app);
        let _ = app.run_on_main_thread(crate::recent::clear);
    }

    /// 对应 native.ts recentRemove：单条移除并重建菜单
    ///
    /// 系统 API 没有「删除单条」的接口，只能整体清空后按旧→新重放剩余条目
    /// （与 recent.cjs 的做法一致：反序回放让最新的那条最后登记、排在最前）
    pub fn recent_remove(&self, app: &AppHandle, path: &str) {
        let remaining: Vec<String> = {
            let mut g = self.inner.lock().expect("shell state 中毒");
            g.recents.retain(|r| r.path != path);
            g.recents.iter().map(|r| r.path.clone()).collect()
        };
        self.rebuild_menu(app);
        let _ = app.run_on_main_thread(move || {
            crate::recent::clear();
            for path in remaining.iter().rev() {
                crate::recent::note(path);
            }
        });
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
        self.inner
            .lock()
            .expect("shell state 中毒")
            .sort_locale
            .clone()
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
