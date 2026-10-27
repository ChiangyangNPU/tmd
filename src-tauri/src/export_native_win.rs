//! 导出链平台原语（Windows / WebView2），与 export_native.rs（macOS）同签名。
//!
//! 模块切换在 main.rs 完成（`#[path]` + cfg），exporter.rs 的编排层因此
//! 完全跨平台、零分叉——本文件只提供编排层需要的四个原语：
//!
//! - **JS 执行**：`ICoreWebView2::ExecuteScript`。结果是 JSON 编码的，解码后
//!   还原 mac 侧「脚本返回字符串 → 原样字符串」的语义（`null` → 空串）
//! - **截图**：`ICoreWebView2::CapturePreview`（PNG 写内存 IStream）。
//!   WebView2 无 rect 参数：区域模式先截全视口，再按 devicePixelRatio 把
//!   DIP 矩形换算成物理像素裁剪（png crate 解码/重编码）
//! - **PDF**：`ICoreWebView2_16::PrintToPdf`（直写临时文件后读回）。走
//!   Chromium 打印管线：@media print / @page 生效，页尺寸/朝向/页边距/
//!   页眉页脚均可用——比 mac 的 createPDF 矩形直出更接近 Electron；
//!   仅「大纲书签」（outline）无对应项，见 docs/Tauri迁移评估.md
//!
//! 线程模型与 mac 完全一致：with_webview 的闭包在主线程执行（COM 对象
//! 不跨线程），异步 completion 回调经 mpsc 交回调用线程阻塞等待，
//! 主 message loop 继续泵消息驱动回调。
//!
//! @author chiangyang

use std::sync::mpsc;
use std::time::Duration;

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_16,
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::{
    CapturePreviewCompletedHandler, ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler,
};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{IStream, STATFLAG_DEFAULT, STATSTG, STREAM_SEEK_SET};

/// 在 webview 内执行 JS 并取字符串结果（对应 mac 的 evaluateJavaScript）。
///
/// WebView2 的 ExecuteScript 结果是 JSON：脚本返回字符串时得到带引号的
/// JSON 字符串，返回 undefined/null 时得到 `null`。这里解码还原 mac 语义
/// （字符串原样、null → 空串、其余返回 JSON 原文），两侧脚本可共用。
pub(crate) fn eval_js(window: &WebviewWindow, script: &str) -> Result<String, String> {
    let script = HSTRING::from(script);
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    window
        .with_webview(move |platform| {
            let outcome = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败: {}", e))?;
                let tx = tx.clone();
                let done = ExecuteScriptCompletedHandler::create(Box::new(move |hr, result| {
                    let _ = tx.send(match hr {
                        Err(e) => Err(format!("ExecuteScript 失败: {}", e)),
                        Ok(()) => Ok(decode_script_result(&result)),
                    });
                    Ok(())
                }));
                unsafe { core.ExecuteScript(&script, &done) }
                    .map_err(|e| format!("发起 ExecuteScript 失败: {}", e))
            })();
            if let Err(err) = outcome {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "ExecuteScript 超时".to_string())?
}

/// ExecuteScript 的 JSON 结果 → 与 mac 一致的字符串语义：
/// `"ok"` → `ok`；`null`（脚本无返回值）→ 空串；其余保留 JSON 原文。
fn decode_script_result(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Null) => String::new(),
        _ => raw.to_string(),
    }
}

/// 读取渲染层内容尺寸（scrollWidth/scrollHeight，web page 坐标）
#[allow(dead_code)] // 与 mac 模块保持同签名；正式导出链当前走 .ProseMirror 测量
pub(crate) fn read_content_metrics(window: &WebviewWindow) -> Result<(f64, f64), String> {
    let s = eval_js(
        window,
        "JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})",
    )?;
    serde_json::from_str::<serde_json::Value>(&s)
        .ok()
        .and_then(|v| Some((v["w"].as_f64()?, v["h"].as_f64()?)))
        .ok_or_else(|| "内容尺寸解析失败".to_string())
}

/// 视口截图（对应 Electron capturePage 无参形态）：返回 PNG 字节
#[allow(dead_code)] // 与 mac 模块保持同签名（探针/验证用）
pub(crate) fn capture_viewport_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    capture_png(window, None)
}

/// 截图（CapturePreview）：rect=None 截整个视口（长图分段）；rect=Some 截
/// 视口内区域（DIP 坐标，Word/ePub 公式栅格化用）。
/// 区域模式：CapturePreview 无 rect 参数，截全视口后按窗口 dpr 裁剪。
pub(crate) fn capture_png(
    window: &WebviewWindow,
    rect: Option<(f64, f64, f64, f64)>,
) -> Result<Vec<u8>, String> {
    let dpr = window.scale_factor().unwrap_or(1.0);
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |platform| {
            let outcome = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败: {}", e))?;
                // 内存流：CapturePreview 完成时 PNG 已全部写入，读回即可
                let stream: IStream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
                    .map_err(|e| format!("创建内存流失败: {}", e))?;
                let tx = tx.clone();
                let stream_for_cb = stream.clone();
                let done = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
                    let result = (|| -> Result<Vec<u8>, String> {
                        hr.map_err(|e| format!("CapturePreview 失败: {}", e))?;
                        read_stream(&stream_for_cb)
                    })();
                    let _ = tx.send(result);
                    Ok(())
                }));
                unsafe {
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &done,
                    )
                }
                .map_err(|e| format!("发起 CapturePreview 失败: {}", e))
            })();
            if let Err(err) = outcome {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| e.to_string())?;
    let png = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "CapturePreview 超时（30s）".to_string())??;
    match rect {
        Some(r) => crop_png(&png, r, dpr),
        None => Ok(png),
    }
}

/// 读 IStream 全部内容（Seek(0) 后用 Stat 尺寸一次读完）
fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("截图流定位失败: {}", e))?;
        let mut stat = STATSTG::default();
        stream
            .Stat(&mut stat, STATFLAG_DEFAULT)
            .map_err(|e| format!("截图流尺寸读取失败: {}", e))?;
        let size = stat.cbSize as usize;
        if size == 0 {
            return Err("截图流为空（CapturePreview 未写入数据）".to_string());
        }
        let mut buf = vec![0u8; size];
        let mut read: u32 = 0;
        stream
            .Read(buf.as_mut_ptr() as *mut _, size as u32, Some(&mut read))
            .ok()
            .map_err(|e| format!("截图流读取失败: {}", e))?;
        buf.truncate(read as usize);
        Ok(buf)
    }
}

/// 全视口 PNG 裁剪到 DIP 矩形（内部按 dpr 换算为物理像素并钳制边界）
fn crop_png(png_bytes: &[u8], rect: (f64, f64, f64, f64), dpr: f64) -> Result<Vec<u8>, String> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
        .read_info()
        .map_err(|e| format!("截图 PNG 解析失败: {}", e))?;
    let buf_size = reader
        .output_buffer_size()
        .ok_or_else(|| "截图 PNG 尺寸超出可表示范围".to_string())?;
    let mut buf = vec![0u8; buf_size];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("截图 PNG 解码失败: {}", e))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err(format!("截图位深不支持裁剪: {:?}", info.bit_depth));
    }
    let bpp = info.color_type.samples();
    let (img_w, img_h) = (info.width, info.height);
    let src_stride = img_w as usize * bpp;

    // DIP → 物理像素（CapturePreview 输出即物理像素）
    let x = (rect.0 * dpr).round().max(0.0);
    let y = (rect.1 * dpr).round().max(0.0);
    let w = (rect.2 * dpr).round().max(1.0);
    let h = (rect.3 * dpr).round().max(1.0);
    let x0 = (x as u32).min(img_w.saturating_sub(1));
    let y0 = (y as u32).min(img_h.saturating_sub(1));
    let cw = (w as u32).min(img_w - x0);
    let ch = (h as u32).min(img_h - y0);
    if cw == 0 || ch == 0 {
        return Err(format!(
            "裁剪区域超出截图范围（请求 {:?}，图像 {}×{}）",
            rect, img_w, img_h
        ));
    }
    let row_bytes = cw as usize * bpp;
    let mut cropped = Vec::with_capacity(row_bytes * ch as usize);
    for row in 0..ch as usize {
        let start = (y0 as usize + row) * src_stride + x0 as usize * bpp;
        cropped.extend_from_slice(&buf[start..start + row_bytes]);
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(std::io::Cursor::new(&mut out), cw, ch);
        encoder.set_color(info.color_type);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("裁剪 PNG 编码失败: {}", e))?;
        writer
            .write_image_data(&cropped)
            .map_err(|e| format!("裁剪 PNG 写入失败: {}", e))?;
    }
    Ok(out)
}

/// 全文档 PDF（对应 mac 的 createPDF）：PrintToPdf 走 Chromium 打印管线，
/// 自动分页（@media print / @page 生效），页尺寸/朝向/边距/页眉页脚按
/// options 映射；content_width/height 仅作无 options 时的兜底日志。
///
/// 相对 mac 的差异：mac 为「整页矩形直出」，这里是真正的分页打印——
/// 与 Electron printToPDF 同管线。outline（大纲书签）无对应设置项。
pub(crate) fn capture_full_pdf(
    window: &WebviewWindow,
    content_width: f64,
    content_height: f64,
    options: Option<&serde_json::Value>,
) -> Result<Vec<u8>, String> {
    let title = options
        .and_then(|o| o.get("title"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let settings_snapshot = PdfSettings::from_options(options);
    // 唯一临时文件：pid + 纳秒，任务串行但避免异常路径残留同名覆盖
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_path =
        std::env::temp_dir().join(format!("tmd-export-{}-{}.pdf", std::process::id(), stamp));
    let out_hstring = HSTRING::from(out_path.to_string_lossy().as_ref());

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            let outcome = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|e| format!("取 CoreWebView2 失败: {}", e))?;
                let env = platform.environment();
                let env6: ICoreWebView2Environment6 = env
                    .cast()
                    .map_err(|e| format!("WebView2 环境版本过低（需 Environment6）: {}", e))?;
                let settings = unsafe { env6.CreatePrintSettings() }
                    .map_err(|e| format!("创建打印设置失败: {}", e))?;
                settings_snapshot.apply(&settings, title.as_deref());
                let v16: ICoreWebView2_16 = core.cast().map_err(|e| {
                    format!(
                        "WebView2 版本不支持 PrintToPdf（需 ICoreWebView2_16）: {}",
                        e
                    )
                })?;
                let tx = tx.clone();
                let done = PrintToPdfCompletedHandler::create(Box::new(move |hr, succeeded| {
                    let _ = tx.send(match hr {
                        Err(e) => Err(format!("PrintToPdf 失败: {}", e)),
                        Ok(()) if !succeeded => {
                            Err("PrintToPdf 返回未成功（打印管线拒绝）".to_string())
                        }
                        Ok(()) => Ok(()),
                    });
                    Ok(())
                }));
                unsafe { v16.PrintToPdf(&out_hstring, &settings, &done) }
                    .map_err(|e| format!("发起 PrintToPdf 失败: {}", e))
            })();
            if let Err(err) = outcome {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| "PrintToPdf 超时（60s）".to_string())??;
    let bytes = std::fs::read(&out_path).map_err(|e| format!("读取 PDF 产物失败: {}", e))?;
    let _ = std::fs::remove_file(&out_path);
    if !bytes.starts_with(b"%PDF-") {
        return Err(format!(
            "PDF 产物头非法（{} 字节，内容 {}×{}）",
            bytes.len(),
            content_width,
            content_height
        ));
    }
    Ok(bytes)
}

/// PdfOptions → ICoreWebView2PrintSettings 的映射快照（纯数据，可单测）。
/// 字段口径见 src/pdf-options.ts（pageSize / orientation / margin /
/// headerFooter / pageNumbers / outline）。
#[derive(Debug, PartialEq)]
pub(crate) struct PdfSettings {
    /// 页宽（英寸，未旋转的纵向纸张尺寸；朝向由 SetOrientation 处理）
    pub page_width_in: f64,
    pub page_height_in: f64,
    pub landscape: bool,
    /// 四边统一页边距（英寸）
    pub margin_in: f64,
    /// 页眉页脚（含页码）；对应 headerFooter || pageNumbers
    pub header_footer: bool,
}

impl PdfSettings {
    /// 默认 A4 纵向 + 18mm 边距，与 DEFAULT_PDF_OPTIONS 对齐
    pub(crate) fn from_options(options: Option<&serde_json::Value>) -> Self {
        let mut s = PdfSettings {
            page_width_in: 8.27,
            page_height_in: 11.69,
            landscape: false,
            margin_in: 18.0 / 25.4,
            header_footer: false,
        };
        let Some(o) = options else { return s };
        let (w, h) = match o.get("pageSize").and_then(|v| v.as_str()) {
            Some("A3") => (11.69, 16.54),
            Some("A5") => (5.83, 8.27),
            Some("Letter") => (8.5, 11.0),
            Some("Legal") => (8.5, 14.0),
            _ => (8.27, 11.69),
        };
        s.page_width_in = w;
        s.page_height_in = h;
        s.landscape = o.get("orientation").and_then(|v| v.as_str()) == Some("landscape");
        s.margin_in = match o.get("margin").and_then(|v| v.as_str()) {
            Some("narrow") => 10.0,
            Some("wide") => 25.0,
            _ => 18.0,
        } / 25.4;
        let header_footer = o
            .get("headerFooter")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let page_numbers = o
            .get("pageNumbers")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        s.header_footer = header_footer || page_numbers;
        s
    }

    /// 应用到 WebView2 打印设置（COM 调用失败不阻断：默认值即兜底）
    fn apply(&self, settings: &ICoreWebView2PrintSettings, title: Option<&str>) {
        unsafe {
            // 与 Electron printToPDF 的 printBackground: true 同口径
            let _ = settings.SetShouldPrintBackgrounds(true);
            let _ = settings.SetShouldPrintHeaderAndFooter(self.header_footer);
            if self.header_footer {
                if let Some(t) = title.filter(|t| !t.is_empty()) {
                    let _ = settings.SetHeaderTitle(&HSTRING::from(t));
                }
            }
            let _ = settings.SetOrientation(if self.landscape {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            });
            let _ = settings.SetPageWidth(self.page_width_in);
            let _ = settings.SetPageHeight(self.page_height_in);
            let _ = settings.SetMarginTop(self.margin_in);
            let _ = settings.SetMarginBottom(self.margin_in);
            let _ = settings.SetMarginLeft(self.margin_in);
            let _ = settings.SetMarginRight(self.margin_in);
        }
    }
}

// ---------- 原语自动化验证（TMD_SPIKE_EXPORT_OPS=1） ----------

/// 原语三件套自测：视口截帧 / 区域截帧 / PDF，产物与统计写日志 + stderr。
/// 主窗口就绪后调用；用于 Windows 首次落地时的可复跑验收（发布前移除）。
pub(crate) fn verify_native(app: &tauri::AppHandle) {
    use tauri::Manager;
    let log = |level: &str, msg: &str| {
        eprintln!("[tmd-spike] {}", msg);
        if let Some(logger) = crate::logger::global() {
            logger.log(level, "main", msg, None, &crate::logger::LogMeta::default());
        }
    };
    let Some(win) = app.get_webview_window("main") else {
        log("error", "原语验证: 主窗口不存在");
        return;
    };
    let dir = std::env::temp_dir();

    // ① 视口截帧（全视口 PNG + 尺寸 + 非白像素比）
    match capture_png(&win, None) {
        Ok(png) => match png_stats(&png) {
            Ok((w, h, non_white)) => {
                let path = dir.join("tmd-spike-viewport.png");
                let _ = std::fs::write(&path, &png);
                log(
                    "warn",
                    &format!(
                        "原语验证①视口截帧 OK: {}×{} 非白 {:.2}% → {}",
                        w,
                        h,
                        non_white * 100.0,
                        path.display()
                    ),
                );
            }
            Err(err) => log("error", &format!("原语验证①视口截帧 PNG 异常: {}", err)),
        },
        Err(err) => log("error", &format!("原语验证①视口截帧失败: {}", err)),
    }
    let dpr = win.scale_factor().unwrap_or(1.0);

    // ② 区域截帧（裁剪尺寸应与请求 rect×dpr 一致）
    let (rx, ry, rw, rh) = (24.0, 16.0, 320.0, 160.0);
    match capture_png(&win, Some((rx, ry, rw, rh))) {
        Ok(png) => match png_stats(&png) {
            Ok((w, h, non_white)) => {
                let expect_w = (rw * dpr).round() as u32;
                let expect_h = (rh * dpr).round() as u32;
                let dims_ok = w == expect_w && h == expect_h;
                let path = dir.join("tmd-spike-region.png");
                let _ = std::fs::write(&path, &png);
                log(
                    if dims_ok { "warn" } else { "error" },
                    &format!(
                        "原语验证②区域截帧{}: {}×{}（期望 {}×{}，dpr {}）非白 {:.2}% → {}",
                        if dims_ok { " OK" } else { "尺寸不符" },
                        w,
                        h,
                        expect_w,
                        expect_h,
                        dpr,
                        non_white * 100.0,
                        path.display()
                    ),
                );
            }
            Err(err) => log("error", &format!("原语验证②区域截帧 PNG 异常: {}", err)),
        },
        Err(err) => log("error", &format!("原语验证②区域截帧失败: {}", err)),
    }

    // ③ PDF（PrintToPdf 默认 A4 + 背景）
    match capture_full_pdf(&win, 0.0, 0.0, None) {
        Ok(bytes) => {
            let path = dir.join("tmd-spike-export.pdf");
            let _ = std::fs::write(&path, &bytes);
            log(
                "warn",
                &format!(
                    "原语验证③PDF OK: {} 字节，%PDF- 头 → {}",
                    bytes.len(),
                    path.display()
                ),
            );
        }
        Err(err) => log("error", &format!("原语验证③PDF 失败: {}", err)),
    }
}

/// PNG 尺寸 + 非白像素比（按步长采样，验证用，不追求精确）
fn png_stats(png_bytes: &[u8]) -> Result<(u32, u32, f64), String> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
        .read_info()
        .map_err(|e| e.to_string())?;
    let buf_size = reader
        .output_buffer_size()
        .ok_or_else(|| "PNG 尺寸异常".to_string())?;
    let mut buf = vec![0u8; buf_size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let bpp = info.color_type.samples();
    let (w, h) = (info.width, info.height);
    let mut sampled = 0u64;
    let mut non_white = 0u64;
    // 步长采样：最多约 20 万点，长图也不至于慢
    let step = ((w as u64 * h as u64 / 200_000).max(1)) as usize;
    let mut idx = 0usize;
    let total = w as usize * h as usize;
    while idx < total {
        let off = idx * bpp;
        let (r, g, b) = (buf[off], buf[off + 1], buf[off + 2]);
        if r < 245 || g < 245 || b < 245 {
            non_white += 1;
        }
        sampled += 1;
        idx += step;
    }
    Ok((w, h, non_white as f64 / sampled.max(1) as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 脚本结果解码与 mac 语义对齐：字符串原样、null 空串、其余 JSON 原文
    #[test]
    fn decode_script_result_matches_mac_semantics() {
        assert_eq!(decode_script_result("\"ok\""), "ok");
        assert_eq!(decode_script_result("null"), "");
        assert_eq!(
            decode_script_result("\"complete|http://x\""),
            "complete|http://x"
        );
        assert_eq!(decode_script_result("{\"w\":1}"), "{\"w\":1}");
        assert_eq!(decode_script_result("raw-not-json"), "raw-not-json");
    }

    /// PDF 选项映射：默认 A4 纵向 / 18mm；各枚举与页眉页脚合成
    #[test]
    fn pdf_settings_map_frontend_options() {
        let def = PdfSettings::from_options(None);
        assert_eq!(def.page_width_in, 8.27);
        assert!(!def.landscape);
        assert!(def.header_footer == false);

        let opts = serde_json::json!({
            "pageSize": "Letter", "orientation": "landscape",
            "margin": "wide", "headerFooter": false, "pageNumbers": true
        });
        let s = PdfSettings::from_options(Some(&opts));
        assert_eq!(s.page_width_in, 8.5);
        assert_eq!(s.page_height_in, 11.0);
        assert!(s.landscape);
        assert!((s.margin_in - 25.0 / 25.4).abs() < 1e-9);
        // pageNumbers 单独开启也要出页眉页脚（页码随页眉页脚产出）
        assert!(s.header_footer);

        let opts = serde_json::json!({ "pageSize": "B5", "margin": "narrow" });
        let s = PdfSettings::from_options(Some(&opts));
        assert_eq!(s.page_width_in, 8.27); // 未知尺寸回落 A4
        assert!((s.margin_in - 10.0 / 25.4).abs() < 1e-9);
    }
}
