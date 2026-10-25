//! 导出链平台原语原型（阶段 B go/no-go 验证，macOS）。
//!
//! 评估文档（Tauri迁移评估.md §3.3）判定 wry 无 printToPDF/capturePage 等价物
//! ——本模块验证绕过 wry、经 objc2 直调 WKWebView 原生 API 的替代路径：
//!
//! - **PDF**：`createPDFWithConfiguration`（macOS 11+）。WKPDFConfiguration.rect
//!   是 **web page 坐标**——设全文档尺寸即可一次调用生成整页多段 PDF，
//!   能力对齐 Electron `printToPDF`（含打印到文件），且无需打印对话框
//! - **截图**：`takeSnapshotWithConfiguration`（rect 为 view 坐标，仅视口）——
//!   与 Electron `capturePage` 的视口语义一致，长图的分段滚动 + 拼接管线
//!   （export-bridge.ts 既有契约）可直接复用
//!
//! 实现要点：with_webview 闭包在主线程执行（MainThreadMarker 可用）；
//! createPDF/takeSnapshot 的 completion 是异步回调，经 mpsc 通道回传，
//! 命令线程阻塞等待（不占主线程，主 runloop 继续驱动回调）。

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKPDFConfiguration, WKWebView};
use std::sync::mpsc;
use std::time::Duration;
use tauri::WebviewWindow;

/// 从 Tauri 窗口取 WKWebView 引用并在主线程执行闭包
fn with_wk<T, F>(window: &WebviewWindow, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&WKWebView) -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |platform| {
            let wk = unsafe { &*(platform.inner() as *mut WKWebView) };
            let _ = tx.send(f(wk));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "with_webview 派发超时".to_string())
}

/// 在 webview 内执行 JS 并取字符串结果（completion 经 mpsc 回传，阻塞等待）。
///
/// 约定：脚本应返回**字符串**（内部把回调对象按 NSString 强转取值）；
/// 返回 Promise 不保证等 resolve（WKWebView 行为未定义），需要沉降的
/// 一律由调用方 sleep。正式导出链（滚动定位、内容注入、就绪探测）与
/// spike 探针共用本入口。
pub(crate) fn eval_js(window: &WebviewWindow, script: &str) -> Result<String, String> {
    let script = script.to_string();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    with_wk(window, move |wk| unsafe {
        let script = NSString::from_str(&script);
        let done = RcBlock::new(
            move |result: *mut objc2::runtime::AnyObject, err: *mut NSError| {
                let system_msg = if err.is_null() {
                    String::new()
                } else {
                    (*err).localizedDescription().to_string()
                };
                let outcome = (|| -> Result<String, String> {
                    // undefined / null 的回调指针为空：按空串处理而非报错
                    if result.is_null() {
                        return Ok(String::new());
                    }
                    // 回调对象是 autoreleased（+0）：retain_autoreleased 接管所有权；
                    // 契约要求脚本返回字符串，downcast 失败即脚本违约
                    let any = Retained::retain_autoreleased(result).ok_or("结果指针为空")?;
                    let s: Retained<NSString> = any
                        .downcast()
                        .map_err(|_| "结果不是字符串（脚本须返回字符串）".to_string())?;
                    Ok(s.to_string())
                })();
                let _ = tx.send(
                    outcome.map_err(|e| format!("evaluateJavaScript 失败: {}{}", e, system_msg)),
                );
            },
        );
        wk.evaluateJavaScript_completionHandler(&*script, Some(&done));
    })?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "evaluate 超时".to_string())?
}

/// 读取渲染层内容尺寸（scrollWidth/scrollHeight，web page 坐标）
pub(crate) fn read_content_metrics(window: &WebviewWindow) -> Result<(f64, f64), String> {
    // 二分定位 step：先验证 with_wk + objc2 引用与只读访问是否可用
    let title_probe: Result<String, String> = with_wk(window, move |wk| unsafe {
        match wk.title() {
            Some(s) => s.to_string(),
            None => String::new(),
        }
    });
    eprintln!(
        "[tmd-spike] title 探针: {:?}",
        title_probe
            .as_ref()
            .map(|s| s.chars().take(40).collect::<String>())
    );
    if let Err(err) = title_probe {
        return Err(format!("title 探针失败（objc2 通路问题）: {}", err));
    }
    let s = eval_js(
        window,
        "JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})",
    )?;
    serde_json::from_str::<serde_json::Value>(&s)
        .ok()
        .and_then(|v| Some((v["w"].as_f64()?, v["h"].as_f64()?)))
        .ok_or_else(|| "内容尺寸解析失败".to_string())
}

/// 全文档 PDF：rect 设 web page 坐标全尺寸，一次调用生成整页多段 PDF
/// （对应 Electron printToPDF 的打印到文件能力，无需打印对话框）
pub(crate) fn capture_full_pdf(
    window: &WebviewWindow,
    content_width: f64,
    content_height: f64,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    with_wk(window, move |wk| unsafe {
        let mtm = MainThreadMarker::new().expect("with_webview 必在主线程");
        let config = WKPDFConfiguration::new(mtm);
        config.setRect(CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(content_width, content_height),
        ));
        let done = RcBlock::new(
            move |data: *mut objc2_foundation::NSData, err: *mut NSError| {
                let _ = tx.send(if data.is_null() {
                    let msg = if err.is_null() {
                        String::new()
                    } else {
                        (*err).localizedDescription().to_string()
                    };
                    Err(format!("createPDF 失败: {}", msg))
                } else {
                    Ok((*data).to_vec())
                });
            },
        );
        wk.createPDFWithConfiguration_completionHandler(Some(&*config), &done);
    })?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "createPDF 超时（30s）".to_string())?
}

/// 视口截图（对应 Electron capturePage 无参形态）：返回 PNG 字节。
/// 长图 = 分段滚动捕获 + export-bridge.ts 既有拼接管线（与 Electron 同构）。
/// NSImage→PNG 转换在主线程闭包内完成（Retained<NSImage> 非 Send 不能跨线程）。
pub(crate) fn capture_viewport_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    with_wk(window, move |wk| unsafe {
        let done = RcBlock::new(
            move |image: *mut objc2_app_kit::NSImage, err: *mut NSError| {
                let _ = tx.send((|| -> Result<Vec<u8>, String> {
                    if image.is_null() {
                        let msg = if err.is_null() {
                            String::new()
                        } else {
                            (*err).localizedDescription().to_string()
                        };
                        return Err(format!("takeSnapshot 失败: {}", msg));
                    }
                    let img = Retained::retain_autoreleased(image)
                        .ok_or_else(|| "takeSnapshot 图像指针无效".to_string())?;
                    let cg = img
                        .CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None)
                        .ok_or("NSImage CGImage 获取失败")?;
                    // NSBitmapImageRep 三步 msg_send（initWithCGImage 与
                    // representationUsingType 是两个独立方法，不能合并选择器）；
                    // 闭包体外层已是 unsafe 块，msg_send! 无需再各自包裹
                    let rep: *mut NSBitmapImageRep =
                        objc2::msg_send![objc2::class!(NSBitmapImageRep), alloc];
                    if rep.is_null() {
                        return Err("NSBitmapImageRep alloc 失败".to_string());
                    }
                    let rep: *mut NSBitmapImageRep = objc2::msg_send![rep, initWithCGImage: &*cg];
                    if rep.is_null() {
                        return Err("NSBitmapImageRep initWithCGImage 失败".to_string());
                    }
                    let empty: Retained<objc2_foundation::NSDictionary> =
                        objc2_foundation::NSDictionary::new();
                    let png_data: *mut objc2_foundation::NSData = objc2::msg_send![
                        rep,
                        representationUsingType: NSBitmapImageFileType::PNG,
                        properties: &*empty
                    ];
                    if png_data.is_null() {
                        return Err("NSBitmapImageRep PNG 转换失败".to_string());
                    }
                    Ok(Retained::retain_autoreleased(png_data)
                        .ok_or("PNG 数据指针无效")?
                        .to_vec())
                })());
            },
        );
        wk.takeSnapshotWithConfiguration_completionHandler(None, &done);
    })?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "takeSnapshot 超时（30s）".to_string())?
}
