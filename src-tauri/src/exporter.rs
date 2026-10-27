//! 离屏导出服务（Word / 长图 / ePub）——Tauri 壳正式实现，对齐
//! electron/exporter.cjs 的薄壳分工：本模块只管导出窗口生命周期与平台
//! 原语（尺寸设置 + 截帧 + 图片白名单读盘 + 保存框落盘），真正的编排
//! （Markdown 注入、Mermaid/KaTeX 渲染、分段、拼接、OOXML 转换）全部
//! 留在离屏页 src/export-renderer.ts，与 Electron 完全共用同一套 TS。
//!
//! 与 Electron 的差异点（形态矩阵结论，见 docs/spike-tauri.md）：
//! - **窗口形态**：Electron 隐藏 + backgroundThrottling:false（软件合成）；
//!   WKWebView 隐藏窗 rAF 冻结（页面编排会挂死）→ 改用「屏边探出」：
//!   窗口仅 60pt 探在**最右侧屏幕**右缘内维持 occlusion visible，其余
//!   置于屏外，用户几乎无感。任务结束即销毁窗口（不留常驻边条），
//!   下次导出重建（代价为一次页面重载）
//! - **字节回传**：Electron 结构化克隆直传 Uint8Array；Tauri invoke 走
//!   JSON——MB 级 PNG 若转数字数组体积膨胀约 6 倍，故离屏页 shim 统一
//!   base64（4/3）回传，本模块解码后经 worker 通道交落盘方
//! - **序列化**：Electron Promise 链 → 专职 worker 线程 + mpsc 队列，
//!   同一时刻只跑一个任务（导出低频，窗口不跨任务复用）
//!
//! @author chiangyang

use crate::export_native;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// 导出窗口 label（命令入参按此校验调用方，伪造调用一律拿不到回执）
pub(crate) const EXPORTER_LABEL: &str = "tmd-exporter";

/// 屏边探出的可见宽度（逻辑 pt）：够维持 occlusion visible，小到无感
const PEEK_PX: f64 = 60.0;

/// 单个导出任务超时（与 Electron 版一致 3 分钟；超时销毁窗口强制复位）
const TASK_TIMEOUT: Duration = Duration::from_secs(180);

/// 尺寸/滚动变更后的渲染沉降（Electron 版为 2×rAF + 50ms；evaluateJavaScript
/// 不保证等待 Promise，rAF 无法回读，改用覆盖两帧时长的固定等待）
const SETTLE: Duration = Duration::from_millis(180);

/// 视口尺寸钳制范围（DIP，与 Electron 版一致）
const MIN_DIP: f64 = 200.0;
const MAX_DIP: f64 = 20000.0;

/// 单张本地图片读取上限（32MB，超限跳过而非撑爆导出内存）
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 本地图片扩展名 → MIME（导出图片本地化白名单，其余一律不读）
const IMAGE_MIME: &[(&str, &str)] = &[
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".bmp", "image/bmp"),
    (".avif", "image/avif"),
    (".svg", "image/svg+xml"),
];

// ---------- 渲染层契约类型（export-bridge.ts / native.ts 逐字段对齐） ----------

/// exportRun 入参（camelCase 由 serde 映射；task 对壳不透明，透传离屏页）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportRunOptions {
    pub task: serde_json::Value,
    pub default_name: String,
    pub filters: Vec<ExportFilter>,
}

/// 保存框文件类型过滤器
#[derive(serde::Deserialize)]
pub(crate) struct ExportFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// 截图原语入参（CSS px；zoom 为 CSS px → DIP 换算系数，见 export-bridge.ts）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRequest {
    pub width_css: Option<f64>,
    pub height_css: Option<f64>,
    pub region: Option<CaptureRegion>,
    pub zoom: f64,
    pub scroll_y_css: Option<f64>,
}

/// 视口内矩形区域（CSS px，相对视口左上角）
#[derive(serde::Deserialize)]
pub(crate) struct CaptureRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 截图原语结果（export-bridge.ts CaptureResult）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureResult {
    data_url: String,
    physical_width: u32,
    physical_height: u32,
    pixel_ratio: f64,
}

/// 离屏页结果回传（字节 base64；见 EXPORTER_API_SHIM 说明）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DonePayload {
    ok: bool,
    bytes_b64: Option<String>,
    error: Option<String>,
}

// ---------- 纯函数（无 Tauri 依赖，可单测） ----------

/// file:// URL → 本地绝对路径（与 electron/exporter.cjs fileUrlToPath 同口径）。
/// 兼容 POSIX 与 Windows 盘符形态；非 file: 协议、相对路径、非法转义返回 None。
pub(crate) fn file_url_to_path(file_url: &str) -> Option<String> {
    if !file_url.starts_with("file://") {
        return None;
    }
    let mut p = file_url["file://".len()..].to_string();
    // Windows 盘符形态：file:///E:/a.png → /E:/a.png 去掉多余前导斜杠
    let b = p.as_bytes();
    if b.len() >= 4 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        p = p[1..].to_string();
    }
    let decoded = percent_decode(&p)?;
    let d = decoded.as_bytes();
    let posix_abs = d.first() == Some(&b'/');
    let win_abs = d.len() >= 3
        && d[0].is_ascii_alphabetic()
        && d[1] == b':'
        && (d[2] == b'/' || d[2] == b'\\');
    if posix_abs || win_abs {
        Some(decoded)
    } else {
        None
    }
}

/// 仅解码文件路径中合法的百分号转义（两位十六进制）。
/// 孤立 `%` 或非法序列返回 None（与 decodeURIComponent 抛错口径一致：不猜）。
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 由扩展名取图片 MIME（大小写不敏感；白名单外返回 None）
pub(crate) fn image_mime_of(file_path: &str) -> Option<&'static str> {
    let lower = file_path.to_lowercase();
    IMAGE_MIME
        .iter()
        .find(|(ext, _)| lower.ends_with(ext))
        .map(|(_, mime)| *mime)
}

/// 读取本地图片为 data URI（白名单扩展名 + 大小上限），失败一律返回 None：
/// 文件不存在 / 无权限留 alt 文本，不阻断整篇导出（与 Electron 版口径一致）
pub(crate) fn read_image_as_data_uri(file_url: &str) -> Option<String> {
    let path = file_url_to_path(file_url)?;
    let mime = image_mime_of(&path)?;
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let buf = std::fs::read(&path).ok()?;
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(buf)))
}

/// 从 PNG 字节解析物理像素尺寸（IHDR 大端 u32；签名校验防误喂）
fn png_dims(png: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 24 || png[..8] != SIG {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Some((w, h))
}

/// DIP 钳制（与 Electron 版 clampDip 同口径）
fn clamp_dip(v: f64) -> f64 {
    v.max(MIN_DIP).min(MAX_DIP).round()
}

// ---------- 离屏页桥接（exporterAPI 门面，对应 exporter-preload.cjs） ----------

/// 注入导出窗口的初始化脚本：提供 export-bridge.ts 的 ExporterBridge。
/// 与主窗口 TMD_API_SHIM 同机制（__TAURI__.core.invoke / event.listen）。
/// 字节回传 base64：invoke 载荷是 JSON，Uint8Array 直转会膨胀成数字数组。
const EXPORTER_API_SHIM: &str = r#"
(function () {
  if (window.exporterAPI) return
  var core = window.__TAURI__ && window.__TAURI__.core
  var evt = window.__TAURI__ && window.__TAURI__.event
  if (!core || !core.invoke || !evt) return
  var taskCbs = []
  function u8ToB64(u8) {
    var s = '', chunk = 0x8000
    for (var i = 0; i < u8.length; i += chunk)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
    return btoa(s)
  }
  evt.listen('tmd-exporter-task', function (e) {
    for (var i = 0; i < taskCbs.length; i++) taskCbs[i](e.payload)
  })
  window.exporterAPI = {
    onTask: function (cb) { taskCbs.push(cb) },
    taskDone: function (result) {
      return core.invoke('tmd_exporter_done', {
        payload: {
          ok: !!result.ok,
          bytesB64: result.ok && result.bytes ? u8ToB64(result.bytes) : null,
          error: result && result.error ? String(result.error) : null,
        },
      })
    },
    capture: function (req) { return core.invoke('tmd_exporter_capture', { req: req }) },
    readImage: function (fileUrl) {
      return core.invoke('tmd_exporter_read_image', { fileUrl: fileUrl })
    },
  }
})()
"#;

// ---------- 服务状态与专职 worker ----------

/// 当前任务的字节回传通道槽（done 命令 → 等待中的 worker）
type PendingSlot = Arc<Mutex<Option<mpsc::Sender<Result<Vec<u8>, String>>>>>;

/// 导出服务状态：任务队列发送端（worker 消费端由 init 持有）
pub(crate) struct ExporterState {
    tx: mpsc::Sender<Job>,
}

/// pending 槽的 app 管理包装（done 命令经 state 定位回执通道）
pub(crate) struct PendingSlotHandle(pub(crate) PendingSlot);

/// 队列任务：导出载荷 + 结果回执（exportRun 命令侧阻塞等待回执）
struct Job {
    task: serde_json::Value,
    reply: mpsc::Sender<Result<Vec<u8>, String>>,
}

/// 启动导出服务（main.rs setup 调用一次）：注册状态 + 拉起专职 worker。
/// 串行保证由 worker 单线程消费天然成立，前序失败不阻塞后续。
pub(crate) fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<Job>();
    let pending: PendingSlot = Arc::new(Mutex::new(None));
    app.manage(ExporterState { tx: tx.clone() });
    app.manage(PendingSlotHandle(Arc::clone(&pending)));
    std::thread::spawn({
        let app = app.clone();
        move || {
            for job in rx {
                let _ = job.reply.send(run_task(&app, &job.task, &pending));
            }
        }
    });
}

/// 单任务执行：建窗（等就绪）→ 下发事件 → 等回传 → 销毁窗口。
/// 超时/异常路径一律销毁窗口强制复位，避免挂死窗口拖累后续任务
/// （与 Electron 版 destroyWindow 自愈策略同口径）。
fn run_task(
    app: &AppHandle,
    task: &serde_json::Value,
    pending: &PendingSlot,
) -> Result<Vec<u8>, String> {
    let window = ensure_window(app)?;
    let (done_tx, done_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    *pending.lock().expect("导出回传槽中毒") = Some(done_tx);
    // 桥接心跳：包装 exporterAPI 三方法记录调用时点（超时尸检用）
    let _ = export_native::eval_js(
        &window,
        "window.__tmdSteps = []; \
         if (window.exporterAPI) ['capture','readImage','taskDone'].forEach(function(k){ \
           var orig = window.exporterAPI[k]; \
           window.exporterAPI[k] = function(){ \
             window.__tmdSteps.push(k + '@' + Date.now()); \
             return orig.apply(this, arguments); }; \
         }); 'patched'",
    );
    let emit = app
        .emit_to(EXPORTER_LABEL, "tmd-exporter-task", task.clone())
        .map_err(|e| format!("下发导出任务失败: {}", e));
    if let Err(err) = emit {
        *pending.lock().expect("导出回传槽中毒") = None;
        let _ = window.destroy();
        return Err(err);
    }
    let outcome = done_rx.recv_timeout(TASK_TIMEOUT);
    // 任务结束（无论成败）销毁窗口：探边窗口不留常驻，下次导出重建
    *pending.lock().expect("导出回传槽中毒") = None;
    if let Err(_) = outcome {
        // 超时尸检：页面停在哪一步（busy 页面 eval 可能也挂，尽力而为）
        let dump = export_native::eval_js(
            &window,
            "String(document.readyState) + '|' + document.visibilityState + '|' + \
             (window.__tmdSteps || []).join(',')",
        )
        .unwrap_or_else(|e| format!("（尸检 eval 失败: {}）", e));
        trace(&format!("超时尸检: {}", dump));
    }
    let _ = window.destroy();
    match outcome {
        Ok(res) => res,
        Err(_) => Err("导出超时".to_string()),
    }
}

/// 计算探边窗口位置：最右侧屏幕右缘 − 60pt（多显示器时避开右侧邻屏）。
/// Tauri 显示器位置/尺寸是物理像素，逻辑 pt 按该屏缩放换算；混合 DPI
/// 多屏下偏差只影响探边宽度，无功能影响。
fn peek_position(app: &AppHandle) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    let rightmost = monitors
        .iter()
        .max_by_key(|m| (m.position().x as f64 + m.size().width as f64) as i64);
    let x = rightmost
        .map(|m| {
            let scale = m.scale_factor();
            (m.position().x as f64 + m.size().width as f64) / scale - PEEK_PX
        })
        .unwrap_or(1512.0 - PEEK_PX); // 无显示器信息按 14" MBP 逻辑宽兜底
    (x, 120.0)
}

/// 创建导出窗口并等待 export-renderer.html 就绪。
/// 窗口属性要点（形态矩阵结论）：
/// - visible + 探边定位：维持 occlusion visible（rAF 正常、可捕获）
/// - focused：mac 需要 true（探边窗活跃度影响合成）；Windows 用 false
///   不抢用户焦点（WebView2 渲染不依赖焦点）
/// - decorations(false)：60pt 探边内是纯内容，无标题条噪音
fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    // 异常路径残留的同名窗口先销毁（上次任务竞态未及清理）
    if let Some(old) = app.get_webview_window(EXPORTER_LABEL) {
        let _ = old.destroy();
        std::thread::sleep(Duration::from_millis(300));
    }
    let (x, y) = peek_position(app);
    let window = WebviewWindowBuilder::new(
        app,
        EXPORTER_LABEL,
        WebviewUrl::App("export-renderer.html".into()),
    )
    .title("TMD 导出")
    .inner_size(924.0, 1200.0)
    .position(x, y)
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .focused(cfg!(target_os = "macos"))
    .visible(true)
    .initialization_script(EXPORTER_API_SHIM)
    .build()
    .map_err(|e| format!("创建导出窗口失败: {}", e))?;
    // 等页面就绪：readyState=complete 且 URL 是 export-renderer
    // （about:blank 阶段 readyState 也是 complete，必须靠 URL 区分）
    for _ in 0..50 {
        if let Ok(state) =
            export_native::eval_js(&window, "String(document.readyState) + '|' + location.href")
        {
            if state.starts_with("complete|") && state.contains("export-renderer") {
                return Ok(window);
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let _ = window.destroy();
    Err("导出页 15s 未就绪".to_string())
}

/// 导出链步骤日志（来源 main；warn 级别，验证期可观测）
fn trace(msg: &str) {
    if let Some(logger) = crate::logger::global() {
        logger.log(
            "warn",
            "main",
            &format!("导出链: {}", msg),
            None,
            &crate::logger::LogMeta::default(),
        );
    }
}

// ---------- 通道命令（对应 Electron ipcMain.handle 四条） ----------

/// exportRun：保存框（取消返回 null，不启动离屏渲染）→ 队列执行 → 落盘。
/// 阻塞段（对话框 + 队列等待）放 spawn_blocking，不占异步运行时线程。
#[tauri::command]
pub(crate) async fn tmd_export_run(
    app: AppHandle,
    state: tauri::State<'_, ExporterState>,
    options: ExportRunOptions,
) -> Result<Option<crate::SaveAsResult>, String> {
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
            .and_then(crate::dialog_path_string);
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
        Ok(Some(crate::save_as_result_of(path)))
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

// ---------- PDF 导出（print 通道，macOS 降级路径） ----------

/// print：全文档 createPDF + 保存框落盘（对应 ipc-files.cjs 的 IPC.print）。
///
/// macOS 降级说明（已入档 docs/spike-tauri.md）：WKWebView 无 printToPDF
/// 等价物，createPDF 是 web page 矩形直出——**页尺寸/页边距/页眉页脚/
/// 大纲选项暂不生效**（Electron 版走 Chromium 打印管线支持全部选项）。
/// 文档尺寸量自 `.ProseMirror` 内容底缘（编辑器为定高容器，
/// documentElement.scrollHeight 只给视口高——阶段 B 已知结论）。
#[tauri::command]
pub(crate) async fn tmd_print(
    app: AppHandle,
    window: WebviewWindow,
    name: Option<String>,
    options: Option<serde_json::Value>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Ok(false);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_print(&app, name.as_deref(), options))
        .await
        .map_err(|e| format!("PDF 导出异常: {}", e))?
}

/// print 实主体（阻塞线程执行）：测量 → 保存框 → 平台 PDF 原语 → 落盘。
/// 任何失败记日志后返回 false（对齐 Electron 版 catch → false 口径，
/// 渲染层 exportPdf 不 catch，Err 会变成未处理 rejection）。
///
/// 平台差异：mac 为 createPDF 整页矩形直出（options 无消费方）；Windows 为
/// PrintToPdf 分页打印管线，options（页尺寸/朝向/边距/页眉页脚）生效。
fn run_print(
    app: &AppHandle,
    name: Option<&str>,
    options: Option<serde_json::Value>,
) -> Result<bool, String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(false);
    };
    let outcome = (|| -> Result<(), String> {
        // 全文档尺寸：.ProseMirror 内容底缘（web page 坐标），无编辑器时兜底
        let metrics = export_native::eval_js(
            &win,
            "JSON.stringify((()=>{const el=document.querySelector('.ProseMirror'); \
             if(!el) return {w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}; \
             const r=el.getBoundingClientRect(); \
             return {w:Math.max(document.documentElement.scrollWidth,Math.ceil(r.right)),\
                     h:Math.ceil(r.bottom+window.scrollY)};})())",
        )?;
        let v: serde_json::Value =
            serde_json::from_str(&metrics).map_err(|e| format!("尺寸解析失败: {}", e))?;
        let (w, h) = (
            v["w"].as_f64().unwrap_or(0.0),
            v["h"].as_f64().unwrap_or(0.0),
        );
        if w <= 0.0 || h <= 0.0 {
            return Err("文档尺寸测量失败".to_string());
        }
        // 默认文件名：文档名剥 .md/.markdown 后净化（对齐 ipc-files.cjs）
        let raw = name.unwrap_or("").trim();
        let stripped = raw
            .strip_suffix(".markdown")
            .or_else(|| raw.strip_suffix(".md"))
            .unwrap_or(raw)
            .trim();
        let base = if stripped.is_empty() {
            "导出"
        } else {
            stripped
        };
        let safe: String = base
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        let mut dialog = app
            .dialog()
            .file()
            .set_file_name(format!("{}.pdf", safe))
            .add_filter("PDF", &["pdf"]);
        // 对话框标题：插件 Rust API 无对应项（Electron 版 title 仅提示性）
        dialog = dialog.set_title("导出 PDF");
        let picked = dialog
            .blocking_save_file()
            .and_then(crate::dialog_path_string);
        let Some(path) = picked else {
            return Ok(()); // 用户取消：不算失败
        };
        // 把文档名并入 options 供页眉标题使用（Windows 打印管线消费）
        let mut opts = options.unwrap_or_else(|| serde_json::json!({}));
        if let (Some(obj), Some(n)) = (opts.as_object_mut(), name.filter(|n| !n.is_empty())) {
            obj.entry("title").or_insert(serde_json::json!(n));
        }
        let bytes = export_native::capture_full_pdf(&win, w, h, Some(&opts))?;
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {}", path, e))?;
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(true),
        Err(err) => {
            if let Some(logger) = crate::logger::global() {
                logger.log(
                    "error",
                    "main",
                    &format!("PDF 导出失败: {}", err),
                    None,
                    &crate::logger::LogMeta::default(),
                );
            }
            Ok(false)
        }
    }
}

// ---------- 端到端管线验证（spike 自动验证，正式版随原型入口一并移除） ----------

/// 端到端管线验证（TMD_SPIKE_EXPORT_RUN=1 启动 8s 自动触发）：
/// 用最小 longimage 任务走**真实链路**——探边窗 + exporterAPI 桥接 +
/// capture 分段滚动 + TS 侧拼接 + base64 回传——产物落系统临时目录
/// （tmd-export-verify.png，路径见日志）供本地像素分析（不走保存框，便于
/// 无人值守验证）。
pub(crate) fn verify_pipeline(app: &AppHandle) {
    let task = serde_json::json!({
        "lang": "zh-CN",
        "title": "管线验证",
        "bodyHtml": "<h1>正式导出链端到端验证</h1>\
                     <p>探边窗口 + exporterAPI 桥接 + capture 原语 + 分段拼接全链路。</p>\
                     <p>第二段：验证正文样式注入与多段文本排版。</p>\
                     <p>第三段：长图产物应为完整纵向拼接，非白、有标题色。</p>",
        "varsBlock": "",
        "css": "body{font-family:system-ui;padding:24px;line-height:1.8} h1{color:#b00020}",
        "isDark": false,
        "kind": "longimage",
        "baseDir": null,
    });
    let state = app.state::<ExporterState>();
    let (reply_tx, reply_rx) = mpsc::channel();
    let queued = state.tx.send(Job {
        task,
        reply: reply_tx,
    });
    let verdict = match queued {
        Err(_) => Err("导出服务已停止".to_string()),
        Ok(()) => match reply_rx.recv_timeout(TASK_TIMEOUT + Duration::from_secs(30)) {
            Ok(Ok(bytes)) => {
                // 跨平台产物路径（Windows 无 /tmp；日志里给出实际路径便于验收）
                let out = std::env::temp_dir().join("tmd-export-verify.png");
                std::fs::write(&out, &bytes)
                    .map(|_| format!("{}（{} 字节）", out.display(), bytes.len()))
                    .map_err(|e| e.to_string())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("管线验证超时".to_string()),
        },
    };
    if let Some(logger) = crate::logger::global() {
        logger.log(
            if verdict.is_ok() { "warn" } else { "error" },
            "main",
            &format!(
                "导出链验证: {}",
                verdict.as_deref().unwrap_or_else(|e| e.as_str())
            ),
            None,
            &crate::logger::LogMeta::default(),
        );
    }
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_to_path_accepts_posix_and_windows_forms() {
        assert_eq!(
            file_url_to_path("file:///Users/a/%E4%B8%AD.png"),
            Some("/Users/a/中.png".to_string())
        );
        assert_eq!(
            file_url_to_path("file:///E:/pics/a.png"),
            Some("E:/pics/a.png".to_string())
        );
        // 非 file: 协议 / 相对路径（无前导斜杠）/ 非法转义一律拒绝（不猜）
        assert_eq!(file_url_to_path("https://a/b.png"), None);
        assert_eq!(file_url_to_path("file://a/b.png"), None);
        assert_eq!(file_url_to_path("file:///Users/%zz.png"), None);
    }

    #[test]
    fn image_mime_of_whitelists_extensions() {
        assert_eq!(image_mime_of("/a/b.PNG"), Some("image/png"));
        assert_eq!(image_mime_of("/a/b.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_of("/a/b.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime_of("/a/b.txt"), None);
        assert_eq!(image_mime_of("/a/noext"), None);
    }

    #[test]
    fn read_image_rejects_missing_and_non_whitelisted() {
        assert_eq!(read_image_as_data_uri("/no/such/file.png"), None);
        assert_eq!(read_image_as_data_uri("file:///no/such/file.png"), None);
        // 扩展名白名单外：即便文件存在也不读
        let tmp = std::env::temp_dir().join("tmd-exporter-test.js");
        std::fs::write(&tmp, b"x").unwrap();
        assert_eq!(
            read_image_as_data_uri(&format!("file://{}", tmp.to_string_lossy())),
            None
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn read_image_inlines_whitelisted_png() {
        // 1×1 PNG（仅签名 + IHDR 头，读盘路径不校验完整性）
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
            0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
        ];
        let tmp = std::env::temp_dir().join("tmd-exporter-test.png");
        std::fs::write(&tmp, png).unwrap();
        let uri = read_image_as_data_uri(&format!("file://{}", tmp.to_string_lossy()));
        assert!(uri
            .as_deref()
            .unwrap_or("")
            .starts_with("data:image/png;base64,"));
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn png_dims_reads_ihdr() {
        // 签名(8) + IHDR 块长/类型(8) + 宽(4)=10 + 高(4)=20
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
            0, 0, 0, 0x0a, 0, 0, 0, 0x14,
        ];
        assert_eq!(png_dims(png), Some((10, 20)));
        assert_eq!(png_dims(b"not a png"), None);
    }

    #[test]
    fn clamp_dip_matches_electron_bounds() {
        assert_eq!(clamp_dip(100.0), 200.0); // 下限
        assert_eq!(clamp_dip(50000.0), 20000.0); // 上限
        assert_eq!(clamp_dip(924.4), 924.0); // 取整
    }
}
