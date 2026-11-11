//! 系统「最近文档」登记（对齐 Electron 的 `app.addRecentDocument` /
//! `app.clearRecentDocuments`，见 electron/recent.cjs）。
//!
//! 系统层与应用内的最近列表是两份独立数据：应用内列表（[`crate::shell`] 的
//! `recents`）驱动菜单「打开最近文件」，这里登记的才是 Dock 右键菜单 /
//! 资源管理器「最近使用」/ Windows 跳转列表。Electron 侧一直两者并行维护，
//! 缺了这一段，用户从系统入口就找不到刚编辑过的文档。
//!
//! 平台差异：
//! - macOS：`NSDocumentController` 的 `noteNewRecentDocumentURL:` /
//!   `clearRecentDocuments`（Electron 在 mac 上就是这套 API）。这两个方法
//!   只能在主线程调用，故调用方统一经 `AppHandle::run_on_main_thread` 调度
//! - Windows：`SHAddToRecentDocs`（Shell API），一条调用同时喂给任务栏跳转
//!   列表、资源管理器「最近使用的文件」与开始菜单。这里直接 `extern "system"`
//!   声明而不引 `windows` crate：该符号是稳定 ABI，声明只有一行，不必为一个
//!   调用去打开 `Win32_UI_Shell` feature；`#[link]` 显式指明 shell32，不依赖
//!   Tauri 侧是否已链接

/// 登记一份文档到系统最近列表（新条目由系统置顶）
#[cfg(target_os = "macos")]
pub fn note(path: &str) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::{NSString, NSURL};

    // 非主线程直接放弃：系统 API 只允许主线程调用，调用方本应已切回主线程
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let path = NSString::from_str(path);
    let url = NSURL::fileURLWithPath(&path);
    NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
}

/// 清空系统最近列表
#[cfg(target_os = "macos")]
pub fn clear() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSDocumentController;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // SAFETY: 主线程标记已由 MainThreadMarker::new() 保证；sender 传 None 表示
    // 非菜单点击触发的程序化清空（AppKit 允许 nil）。
    unsafe {
        NSDocumentController::sharedDocumentController(mtm).clearRecentDocuments(None);
    }
}

/// SHAddToRecentDocs 的路径标志：`pv` 指向 NUL 结尾的宽字符（UTF-16）路径
#[cfg(windows)]
const SHARD_PATHW: u32 = 3;

/// SHAddToRecentDocs 的「清空」标志：`SHARD_PIDL` + 空指针即清空整个列表
/// （MSDN 文档用法，与 `SHARD_PATH*` 的语义不同，允许 `pv` 为 NULL）
#[cfg(windows)]
const SHARD_PIDL: u32 = 1;

#[cfg(windows)]
#[link(name = "shell32")]
unsafe extern "system" {
    /// 把文档登记到系统「最近使用的文档」，影响任务栏跳转列表与资源管理器
    fn SHAddToRecentDocs(uflags: u32, pv: *const std::ffi::c_void);
}

/// 登记一份文档到系统最近列表（新条目由系统置顶）
#[cfg(windows)]
pub fn note(path: &str) {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: SHARD_PATHW 要求 pv 指向 NUL 结尾的 UTF-16 字符串，wide 在整个
    // 调用期间有效且已补终止符；该 API 不要求 COM 初始化
    unsafe {
        SHAddToRecentDocs(SHARD_PATHW, wide.as_ptr().cast());
    }
}

/// 清空系统最近列表
#[cfg(windows)]
pub fn clear() {
    // SAFETY: SHARD_PIDL + NULL 是文档约定的「清空全部」用法，API 不会解引用
    unsafe {
        SHAddToRecentDocs(SHARD_PIDL, std::ptr::null());
    }
}

/// 未实现平台：保持与应用内列表一致的调用形状，不做任何系统登记
#[cfg(not(any(target_os = "macos", windows)))]
pub fn note(_path: &str) {}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn clear() {}
