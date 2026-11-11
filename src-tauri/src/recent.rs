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
//! - Windows：需要 `SHAddToRecentDocs`（Win32_UI_Shell），暂未实现——当前
//!   构建不在 Windows 上验证签名，留待有真机时补齐；对齐点在 `note`/`clear`
//!   两个函数，补齐时只需替换本文件的实现，调用侧不用改

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

/// 未实现平台：保持与应用内列表一致的调用形状，不做任何系统登记
#[cfg(not(target_os = "macos"))]
pub fn note(_path: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn clear() {}
