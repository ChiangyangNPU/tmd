//! macOS 最大化/还原的自绘逐帧缩放。
//!
//! 原生 `-[NSWindow zoom:]` 的放大过渡由 WindowServer 用「旧画面快照」做缩放，
//! 过渡期间 WKWebView 的远程图层仍停留在旧尺寸（WebKit 页面布局异步提交，
//! 见 wkb 323132），工具栏右侧按钮与居中标题只能等动画结束才跳到新位置。
//! 这里不再调用系统 zoom，而是按帧 `setFrame:display:` 推动真实 resize——
//! 窗口每帧都是真的尺寸变化，页面布局随窗口边缘同步推进。
//!
//! 状态口径：`-[NSWindow isZoomed]` 由 frame 判定（实测手动 setFrame 到
//! visibleFrame 即为 true），因此逐帧动画结束后 `is_maximized()` 自然为真，
//! 无需另立标记；还原目标 frame 在最大化前记录（AppKit 屏幕坐标，左下原点）。

use objc2_app_kit::{NSWindow, NSWindowStyleMask};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_web_kit::WKWebView;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

/// 过渡时长：与系统 zoom 动画观感接近（ms）
const DURATION_MS: f64 = 220.0;
/// 逐帧间隔：约 60fps（ms）
const TICK_MS: u64 = 16;

/// 动画代数：每次 toggle 自增，旧逐帧循环发现代数变化立即退出
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// 动画进行中：窗口几何记录端据此跳过中间帧，避免把过程尺寸当成还原几何
static ANIMATING: AtomicBool = AtomicBool::new(false);
/// 最大化前的窗口 frame，供还原使用
static NORMAL_FRAME: Mutex<Option<CGRect>> = Mutex::new(None);

/// 是否正处于逐帧动画中（主线程之外读取，供几何记录防抖判断）
pub(crate) fn animating() -> bool {
    ANIMATING.load(Ordering::SeqCst)
}

/// 记录当前 frame 为「还原目标」。
/// 启动即最大化时在 `window.maximize()` 之前调用——原生 zoom 的放大过程
/// 不经过 [`toggle`]，不先记下来就没有还原几何可用。
pub(crate) fn remember_current_frame(window: &WebviewWindow) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        if let Ok(ptr) = win.ns_window() {
            let ns: &NSWindow = &*(ptr as *mut NSWindow);
            if !ns.isZoomed() {
                *NORMAL_FRAME.lock().expect("normal frame 锁中毒") = Some(ns.frame());
            }
        }
    });
}

/// 最大化 / 还原切换（自绘逐帧动画）。
pub(crate) fn toggle(window: &WebviewWindow) {
    // 连击时让上一段动画退出，新动画从当前 frame 继续
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let Ok(ptr) = win.ns_window() else {
            finish(generation);
            return;
        };
        let ns: &NSWindow = &*(ptr as *mut NSWindow);
        // 全屏切换由系统接管（与 tao 原生 zoom 的全屏分支同口径，不做 frame 动画）
        if ns.styleMask().contains(NSWindowStyleMask::FullScreen) {
            finish(generation);
            return;
        }
        let current = ns.frame();
        let target = if ns.isZoomed() {
            match *NORMAL_FRAME.lock().expect("normal frame 锁中毒") {
                Some(frame) => frame,
                // 没有记录（来自系统侧缩放）：退回原生行为，至少状态一致
                None => {
                    let _ = win.unmaximize();
                    finish(generation);
                    return;
                }
            }
        } else {
            // 只在非动画过程中记录还原几何：连击时保留上一次的正常 frame
            if !ANIMATING.load(Ordering::SeqCst) {
                *NORMAL_FRAME.lock().expect("normal frame 锁中毒") = Some(current);
            }
            let Some(screen) = ns.screen() else {
                finish(generation);
                return;
            };
            screen.visibleFrame()
        };
        ANIMATING.store(true, Ordering::SeqCst);
        // 圈定 live-resize 区间：WebKit 只对处于 live resize 的视图做同步逐帧
        // 重排；程序化 resize 否则沿用「上一帧拉伸」策略，等于白改
        set_live_resize(&win, true);
        animate(win, ptr as usize, current, target, generation);
    });
}

/// 结束当前这一代动画的「进行中」标记；已被新动画接管时不动（新动画自管）
fn finish(generation: u64) {
    if GENERATION.load(Ordering::SeqCst) == generation {
        ANIMATING.store(false, Ordering::SeqCst);
    }
}

/// 逐帧推进窗口 frame（按绝对时间插值，主线程忙时也不会拖长过渡）
fn animate(window: WebviewWindow, ns_ptr: usize, from: CGRect, to: CGRect, generation: u64) {
    std::thread::spawn(move || {
        let start = Instant::now();
        let duration = Duration::from_millis(DURATION_MS as u64);
        loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            let t = (start.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            // 末帧直接落到目标矩形：isZoomed 依赖 frame 精确等于 visibleFrame
            let rect = if t >= 1.0 {
                to
            } else {
                lerp(from, to, ease_out_cubic(t))
            };
            // display:true —— 立即按新 frame 重绘，页面内容才能贴着边缘走
            let win = window.clone();
            let posted = win.run_on_main_thread(move || unsafe {
                let ns: &NSWindow = &*(ns_ptr as *mut NSWindow);
                ns.setFrame_display(rect, true);
            });
            if posted.is_err() {
                break; // 窗口已销毁
            }
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
        // 末帧已是目标 frame（isZoomed 随之成立）；被新动画接管时不动标记
        // 先沉降最后一帧再退出 live-resize，避免终帧仍在拉伸管线里
        std::thread::sleep(Duration::from_millis(60));
        set_live_resize(&window, false);
        finish(generation);
    });
}

/// 手动开关 WKWebView 的 live-resize 状态（WebKit 据此切换同步逐帧重排）
fn set_live_resize(window: &WebviewWindow, start: bool) {
    let _ = window.with_webview(move |platform| unsafe {
        let wk = &*(platform.inner() as *mut WKWebView);
        if start {
            let _: () = objc2::msg_send![wk, viewWillStartLiveResize];
        } else {
            let _: () = objc2::msg_send![wk, viewDidEndLiveResize];
        }
    });
}

/// 起步快、收尾缓，贴近系统放大动画的节奏
fn ease_out_cubic(t: f64) -> f64 {
    let rest = 1.0 - t;
    1.0 - rest * rest * rest
}

fn lerp(from: CGRect, to: CGRect, t: f64) -> CGRect {
    let x = from.origin.x + (to.origin.x - from.origin.x) * t;
    let y = from.origin.y + (to.origin.y - from.origin.y) * t;
    let width = from.size.width + (to.size.width - from.size.width) * t;
    let height = from.size.height + (to.size.height - from.size.height) * t;
    CGRect::new(CGPoint::new(x, y), CGSize::new(width, height))
}
