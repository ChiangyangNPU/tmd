//! 导出链四条命令（对应 Electron ipcMain.handle 的 exportRun /
//! exporterDone / exporterCapture / exporterReadImage）。

use super::types::{CaptureRequest, CaptureResult, DonePayload, ExportRunOptions};
use super::util::{clamp_dip, png_dims, read_image_as_data_uri, SETTLE};
use super::worker::{trace, ExporterState, Job, PendingSlotHandle, EXPORTER_LABEL, TASK_TIMEOUT};
use crate::export_native;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// exportRun：保存框（取消返回 null，不启动离屏渲染）→ 队列执行 → 落盘。
/// 阻塞段（对话框 + 队列等待）放 spawn_blocking，不占异步运行时线程。
#[tauri::command]
pub(crate) async fn tmd_export_run(
    app: AppHandle,
    state: tauri::State<'_, ExporterState>,
    options: ExportRunOptions,
) -> Result<Option<crate::commands::files::SaveAsResult>, String> {
    let app = app.clone();
    let tx = state.tx.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_file_name(options.default_name.clone());
        for filter in &options.filters {
            let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &exts);
        }
        let picked = dialog
            .blocking_save_file()
            .and_then(crate::commands::files::dialog_path_string);
        let Some(path) = picked else {
            return Ok(None);
        };
        // 队列串行执行（窗口生命周期由 worker 掌管），等待结果字节
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(Job {
            task: options.task,
            reply: reply_tx,
        })
        .map_err(|_| "导出服务已停止".to_string())?;
        let bytes = reply_rx
            .recv_timeout(TASK_TIMEOUT + Duration::from_secs(30))
            .map_err(|_| "导出排队超时".to_string())??;
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {}", path, e))?;
        Ok(Some(crate::commands::files::save_as_result_of(path)))
    })
    .await
    .map_err(|e| format!("导出任务异常: {}", e))?
}

/// 离屏页结果回传（只接受导出窗口自身：其他调用方拿不到回执通道）
#[tauri::command]
pub(crate) fn tmd_exporter_done(
    window: WebviewWindow,
    state: tauri::State<'_, PendingSlotHandle>,
    payload: DonePayload,
) -> Result<(), String> {
    if window.label() != EXPORTER_LABEL {
        return Ok(());
    }
    let mut slot = state.0.lock().expect("导出回传槽中毒");
    if let Some(tx) = slot.take() {
        let err_head: String = payload
            .error
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(60)
            .collect();
        trace(&format!("done 回传 ok={} err={:?}", payload.ok, err_head));
        let result = if payload.ok {
            match payload
                .bytes_b64
                .as_deref()
                .and_then(|b| STANDARD.decode(b).ok())
            {
                Some(bytes) if !bytes.is_empty() => Ok(bytes),
                _ => Err("导出失败：结果字节缺失".to_string()),
            }
        } else {
            Err(payload.error.unwrap_or_else(|| "导出失败".to_string()))
        };
        let _ = tx.send(result);
    }
    Ok(())
}

/// 截图原语（两种模式，见 export-bridge.ts CaptureRequest）：
/// - 视口模式（widthCss+heightCss）：设窗口内容尺寸 → 滚动定位 → 截整视口
/// - 区域模式（region）：不改窗口尺寸，截视口内矩形（Word 公式栅格化）
#[tauri::command]
pub(crate) async fn tmd_exporter_capture(
    window: WebviewWindow,
    req: CaptureRequest,
) -> Result<Option<CaptureResult>, String> {
    // 必须异步 + spawn_blocking：同步命令跑在主线程，而 eval_js/takeSnapshot
    // 经 with_webview 向主线程派发闭包并阻塞等回传——主线程自等即死锁
    // （症状：恰好 evaluate 10s 超时）。窗口句柄 Send，直接搬进阻塞线程。
    tauri::async_runtime::spawn_blocking(move || capture_impl(window, req))
        .await
        .map_err(|e| format!("截图任务异常: {}", e))?
}

/// capture 实主体（阻塞线程执行；两种模式见 export-bridge.ts CaptureRequest）
fn capture_impl(
    window: WebviewWindow,
    req: CaptureRequest,
) -> Result<Option<CaptureResult>, String> {
    if window.label() != EXPORTER_LABEL {
        return Ok(None);
    }
    let zoom = if req.zoom > 0.0 { req.zoom } else { 1.0 };

    // 入参校验（与 Electron 版口径一致：无效即 null，不报错）
    let mut ref_css_w = req.width_css.filter(|v| *v > 0.0).unwrap_or(0.0);
    // 区域矩形：CSS px × zoom → view 坐标（DIP）；负起点钳 0、尺寸下限 1。
    // 区域模式的清晰度基准 = 区域宽（pixelRatio 校验用）
    let rect = if let Some(r) = req.region {
        if !(r.width > 0.0) || !(r.height > 0.0) {
            return Ok(None);
        }
        ref_css_w = r.width;
        Some((
            (r.x * zoom).round().max(0.0),
            (r.y * zoom).round().max(0.0),
            (r.width * zoom).round().max(1.0),
            (r.height * zoom).round().max(1.0),
        ))
    } else {
        if ref_css_w <= 0.0 || req.height_css.filter(|v| *v > 0.0).is_none() {
            return Ok(None);
        }
        None
    };

    if rect.is_none() {
        // 视口模式：先改内容尺寸（set_size 即客户区，等价 setContentSize）
        let w = clamp_dip(req.width_css.unwrap_or(0.0) * zoom);
        let h = clamp_dip(req.height_css.unwrap_or(0.0) * zoom);
        trace(&format!("capture 视口模式 {}×{}（zoom {}）", w, h, zoom));
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| format!("设置导出视口失败: {}", e))?;
        std::thread::sleep(SETTLE);
        // 改尺寸可能重置/钳制滚动位置：长图分段必须改完视口再按目标偏移
        // 重新滚动，否则截到顶部或重复内容（高度敏感回归，与 Electron 同注释）。
        // 滚动失败尽力而为（与 Electron catch 后继续截同口径），记录不中断
        if let Some(top) = req
            .scroll_y_css
            .filter(|v| v.is_finite())
            .map(|v| (v * zoom).round().max(0.0))
        {
            let script = format!(
                "document.documentElement.scrollTop = {t}; document.body.scrollTop = {t}; 'ok'",
                t = top as i64
            );
            if let Err(err) = export_native::eval_js(&window, &script) {
                trace(&format!("滚动定位失败（忽略，继续截帧）: {}", err));
            }
            std::thread::sleep(SETTLE);
        }
    } else {
        trace(&format!("capture 区域模式 {:?}（zoom {}）", rect, zoom));
    }

    let png = export_native::capture_png(&window, rect)?;
    let (pw, ph) = png_dims(&png).ok_or("截图尺寸解析失败（PNG 头异常）")?;
    let ratio = if ref_css_w > 0.0 {
        pw as f64 / ref_css_w
    } else {
        1.0
    };
    Ok(Some(CaptureResult {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(&png)),
        physical_width: pw,
        physical_height: ph,
        pixel_ratio: ratio,
    }))
}

/// 本地图片白名单读盘 → data URI（只接受导出窗口自身调用）
#[tauri::command]
pub(crate) fn tmd_exporter_read_image(
    window: WebviewWindow,
    file_url: String,
) -> Result<Option<String>, String> {
    if window.label() != EXPORTER_LABEL {
        return Ok(None);
    }
    Ok(read_image_as_data_uri(&file_url))
}
