//! 导出窗口形态判定矩阵（阶段 B 后续：离屏导出窗口在 Tauri 下的形态选型）。
//!
//! Electron 侧 Word/长图/ePub 走「隐藏窗口 + backgroundThrottling:false +
//! capturePage（软件合成路径）」（electron/exporter.cjs）。阶段 B 已证 macOS
//! WKWebView 有可见性约束：窗口未上屏时 takeSnapshot / createPDF 均出空白。
//! 本模块对正式导出窗口的候选形态做一次判定实验：
//!
//! - **V1 隐藏**（visible=false）：对照组——预期空白，量化「Electron 原方案
//!   在 Tauri 下不可行」的证据
//! - **V2 屏边探出**（visible=true、无装饰、窗口大部分置于屏幕外、仅约
//!   60px 探边）：靠部分上屏维持 AppKit occlusion visible，正式形态候选——
//!   用户几乎无感，且截图语义不受窗口在屏外部分影响（takeSnapshot 取的是
//!   view 完整图层而非屏幕裁剪）
//!
//! 每形态新建一次性窗口加载**真实 export-renderer.html**（顺带验证离屏导出页
//! 在 Tauri 壳内可启动、无 exporterAPI 桥接时静默空转），注入高辨识度探针
//! 内容（渐变 + 大字行，空白帧无所遁形）后执行 takeSnapshot + createPDF，
//! 产物落 /tmp 供本地像素分析（阶段 B 教训：远程回看不可信，一律本地分析）。
//!
//! @author chiangyang

use crate::export_native;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 探针窗口内容尺寸（逻辑 px，与 Electron 导出窗口同量级）
const PROBE_W: f64 = 924.0;
const PROBE_H: f64 = 1200.0;
/// V2 探出屏幕的可见宽度（逻辑 px）：足以维持 occlusion visible，小到无感
const PEEK_PX: f64 = 60.0;
/// 探针内容高度（CSS px）：超出视口，顺带验证 PDF 的全文档 rect
const PROBE_CONTENT_H: f64 = 3600.0;

/// 矩阵进度日志：stderr（构建/调试可见）+ 应用日志（GUI 触发后可追溯）。
/// 来源固定 main（logger 来源白名单外的入参会被静默丢弃）。
fn note(msg: &str) {
    eprintln!("[tmd-probe] {}", msg);
    if let Some(logger) = crate::logger::global() {
        logger.log(
            "warn",
            "main",
            &format!("导窗矩阵: {}", msg),
            None,
            &crate::logger::LogMeta::default(),
        );
    }
}

/// 依次执行两种形态的探针；单形态失败记录后继续，不中断矩阵
pub(crate) fn run_matrix(app: &AppHandle) {
    note("矩阵开始：V1 隐藏（对照） → V2 屏边探出（候选）");
    for variant in ["v1-hidden", "v2-peek"] {
        if let Err(err) = run_variant(app, variant) {
            note(&format!("{} 失败: {}", variant, err));
        }
    }
    note("矩阵结束：产物在 /tmp/tmd-export-probe-*.{png,pdf}，待本地像素分析");
}

/// 单形态：建窗 → 等就绪 → 注入探针 → 截图 + PDF → 落盘 → 关窗
fn run_variant(app: &AppHandle, variant: &str) -> Result<(), String> {
    let label = format!("tmd-export-probe-{}", variant);

    // 复跑保护：先关掉同名残留窗口（上次矩阵中断时可能留存）
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.close();
        std::thread::sleep(Duration::from_millis(300));
    }

    let mut builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("export-renderer.html".into()))
            .title("TMD export probe")
            .inner_size(PROBE_W, PROBE_H)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true);

    match variant {
        "v1-hidden" => {
            builder = builder.visible(false);
        }
        "v2-peek" => {
            // 主屏逻辑宽（取不到按 14" MBP 1512 兜底）：窗口整体左移到屏外，
            // 只留 PEEK_PX 宽的右边条在屏内
            let screen_w = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.size().width as f64 / m.scale_factor() as f64)
                .unwrap_or(1512.0);
            builder = builder.visible(true).position(screen_w - PEEK_PX, 120.0);
        }
        _ => unreachable!("矩阵只定义了 v1-hidden / v2-peek"),
    }

    let window = builder.build().map_err(|e| format!("建窗失败: {}", e))?;
    note(&format!("{}: 窗口已建", variant));

    // 等页面就绪：readyState=complete 且 URL 是 export-renderer
    // （about:blank 阶段 readyState 也是 complete，必须靠 URL 区分）
    let mut ready = false;
    for _ in 0..50 {
        if let Ok(state) =
            export_native::eval_js(&window, "String(document.readyState) + '|' + location.href")
        {
            if state.starts_with("complete|") && state.contains("export-renderer") {
                ready = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    if !ready {
        let _ = window.close();
        return Err("页面 15s 未就绪（export-renderer.html 加载失败？）".to_string());
    }
    note(&format!("{}: 页面就绪", variant));

    // 注入探针内容：渐变背景 + 大字行（颜色与结构双辨识）
    let inject = format!(
        "(() => {{ document.body.innerHTML = ''; \
         const d = document.createElement('div'); \
         d.style.cssText = 'height:{h}px;background:linear-gradient(160deg,#e74c3c,#f1c40f,#2ecc71,#3498db,#9b59b6);color:#111;font:800 64px/150px monospace;padding:24px;word-break:break-all'; \
         d.textContent = '{v} 导出探针 EXPORT PROBE '.repeat(160); \
         document.body.appendChild(d); \
         document.documentElement.scrollTop = 0; document.body.scrollTop = 0; \
         return 'injected'; }})()",
        h = PROBE_CONTENT_H,
        v = variant,
    );
    export_native::eval_js(&window, &inject).map_err(|e| format!("注入失败: {}", e))?;

    // rAF 探针（正式导出链的隐藏窗关键风险）：export-renderer.ts 的 nextFrames
    // 依赖 requestAnimationFrame；Electron 靠 backgroundThrottling:false 保证
    // 隐藏窗口仍逐帧回调，WKWebView 无此开关——若 rAF 暂停，正式实现须换
    // 探边形态或另想办法（如页面侧退化定时器）。
    export_native::eval_js(
        &window,
        "window.__rafFired = 0; requestAnimationFrame(() => { window.__rafFired = 1 }); 'raf-armed'",
    )
    .map_err(|e| format!("rAF 布防失败: {}", e))?;
    std::thread::sleep(Duration::from_millis(1200));
    let raf = export_native::eval_js(
        &window,
        "String(window.__rafFired) + '|' + document.visibilityState + '|raf:' + String(!!window.requestIdleCallback)",
    )
    .unwrap_or_else(|e| format!("探测失败:{}", e));
    note(&format!("{}: rAF/可见性 = {}", variant, raf));

    // 渐变由 GPU 合成，注入后给一拍时间让图层落地再截
    std::thread::sleep(Duration::from_millis(500));

    // 截图（view 全图层）+ 全文档 PDF（rect 用探针内容高）
    let png = export_native::capture_viewport_png(&window);
    let pdf = export_native::capture_full_pdf(&window, PROBE_W, PROBE_CONTENT_H, None);

    let png_path = format!("/tmp/tmd-export-probe-{}.png", variant);
    let pdf_path = format!("/tmp/tmd-export-probe-{}.pdf", variant);
    let png_msg = png.and_then(|bytes| {
        std::fs::write(&png_path, &bytes).map_err(|e| e.to_string())?;
        Ok(format!("{}（{} 字节）", png_path, bytes.len()))
    });
    let pdf_msg = pdf.and_then(|bytes| {
        std::fs::write(&pdf_path, &bytes).map_err(|e| e.to_string())?;
        Ok(format!("{}（{} 字节）", pdf_path, bytes.len()))
    });
    note(&format!("{}: PNG={:?} PDF={:?}", variant, png_msg, pdf_msg));

    let _ = window.close();
    Ok(())
}
