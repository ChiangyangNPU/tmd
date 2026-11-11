//! 导出服务：专职 worker 线程 + 屏边探出窗口生命周期。
//! 窗口属性要点（形态矩阵结论，见 docs/spike-tauri.md）：visible + 探边
//! 定位维持 occlusion visible（rAF 正常、可捕获）；focused(true) 是渲染
//! 循环的必要条件（focused(false) 时 rAF 非确定性挂死）。

use crate::export_native;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 导出窗口 label（命令入参按此校验调用方，伪造调用一律拿不到回执）
pub(crate) const EXPORTER_LABEL: &str = "tmd-exporter";

/// 屏边探出的可见宽度（逻辑 pt）：够维持 occlusion visible，小到无感
const PEEK_PX: f64 = 60.0;

/// 单个导出任务超时（与 Electron 版一致 3 分钟；超时销毁窗口强制复位）
pub(crate) const TASK_TIMEOUT: Duration = Duration::from_secs(180);

use super::bridge::EXPORTER_API_SHIM;

/// 当前任务的字节回传通道槽（done 命令 → 等待中的 worker）
type PendingSlot = Arc<Mutex<Option<mpsc::Sender<Result<Vec<u8>, String>>>>>;

/// 导出服务状态：任务队列发送端（worker 消费端由 init 持有）
pub(crate) struct ExporterState {
    pub(crate) tx: mpsc::Sender<Job>,
}

/// pending 槽的 app 管理包装（done 命令经 state 定位回执通道）
pub(crate) struct PendingSlotHandle(pub(crate) PendingSlot);

/// 队列任务：导出载荷 + 结果回执（exportRun 命令侧阻塞等待回执）
pub(crate) struct Job {
    pub(crate) task: serde_json::Value,
    pub(crate) reply: mpsc::Sender<Result<Vec<u8>, String>>,
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
                // mac：窗口以 focused(true) 创建是渲染循环的必要条件（focused(false)
                // 的 WKWebView rAF 非确定性挂死，导出管线会卡）——但渲染循环一旦
                // 启动便不再依赖焦点：就绪即把焦点还给主窗口，用户导出期间继续
                // 打字不丢键（此前整段导出期都被离屏窗口占用焦点）
                #[cfg(target_os = "macos")]
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_focus();
                }
                return Ok(window);
            }
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let _ = window.destroy();
    Err("导出页 15s 未就绪".to_string())
}

/// 导出链步骤日志（来源 main；warn 级别，验证期可观测）
pub(crate) fn trace(msg: &str) {
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
