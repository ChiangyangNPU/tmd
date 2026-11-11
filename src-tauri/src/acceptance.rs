//! 验收模式 JS 驱动（环境变量门控）：把「页面内断言」从 mac 无 CDP 的困境里解出来。
//!
//! 背景：Windows 侧整套 GUI 验收（scripts/tauri-acceptance.mjs）建立在 WebView2 的
//! `--remote-debugging-port` + CDP 上；WKWebView 没有等价开关（scripts/tauri-gui-check.mjs
//! 里显式写着「仅支持 Windows」）。但导出链已经打通了「Rust 侧对 WKWebView/WebView2
//! 执行 JS 并取回字符串」的原语——export_native::eval_js（两平台同签名），把它复用为
//! 验收通道即可：断言仍写在 JS 里（与 CDP 版同构），只是注入点从调试协议换成原生 evaluate。
//!
//! 相比外部 AX/CGEvent 方案：无需辅助功能授权、CI 可跑、能直接断言 DOM；
//! 代价是拿不到「真实 OS 级按键」与原生面板（NSOpenPanel）路径——那两项仍归人工。
//!
//! 触发方式（未设 TMD_EVAL_SCRIPT 时零开销，正常启动完全不受影响）：
//! - `TMD_EVAL_SCRIPT=/path/steps.js` 步骤文件，**每行一个同步 JS 表达式**
//! - `TMD_EVAL_OUT=/path/result.json` 结果输出（默认 /tmp/tmd-eval-result.json）
//! - `TMD_EVAL_STEP_DELAY_MS=350` 步间延迟（等 UI 沉降）
//! - `TMD_EVAL_EXIT=1` 跑完直接退出进程（无人值守用）
//!
//! 每行按 `(expr)` 包进 try/catch 并 JSON.stringify 求值，故表达式需返回可 JSON
//! 序列化的值；Promise 不会被等待（WKWebView 的 evaluateJavaScript 语义，
//! 见 export_native.rs 契约），异步场景拆成多步 + 步间延迟。
//!
//! @author chiangyang

use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;

/// ready 可能因窗口重建（macOS Reopen）多次到达，驱动只跑一次
static STARTED: AtomicBool = AtomicBool::new(false);

/// 渲染层 ready 后调用：未配置步骤文件时立即返回（不建线程、不碰 webview）。
pub(crate) fn maybe_start(app: &tauri::AppHandle) {
    if std::env::var_os("TMD_EVAL_SCRIPT").is_none() {
        return;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || run(&app));
}

fn run(app: &tauri::AppHandle) {
    let script_path = std::env::var("TMD_EVAL_SCRIPT").unwrap_or_default();
    let out_path =
        std::env::var("TMD_EVAL_OUT").unwrap_or_else(|_| "/tmp/tmd-eval-result.json".to_string());
    let step_delay = std::env::var("TMD_EVAL_STEP_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(350);
    let exit_when_done = std::env::var("TMD_EVAL_EXIT").as_deref() == Ok("1");

    let payload = execute(app, &script_path, step_delay);
    // 成功/失败都落盘：外部脚本以文件存在与否 + ok 字段判定，避免只靠日志猜
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
    if let Err(err) = fs::write(&out_path, text) {
        eprintln!("[tmd-acceptance] 结果写出失败 {}: {}", out_path, err);
    }
    if exit_when_done {
        // 直接退进程而非 app.exit：后者会走 RunEvent::ExitRequested，脏文档
        // 确认逻辑会拦住退出（无人值守场景下表现为挂死）。日志为同步写，
        // 此处不会丢失落盘内容。
        std::process::exit(0);
    }
}

fn execute(app: &tauri::AppHandle, script_path: &str, step_delay: u64) -> Value {
    let source = match fs::read_to_string(script_path) {
        Ok(s) => s,
        Err(err) => {
            return json!({
                "ok": false,
                "fatal": format!("步骤文件读取失败 {}: {}", script_path, err),
                "steps": []
            })
        }
    };
    // ready 已由渲染层在 boot 末尾调用，这里再给首帧/主题注入留一点沉降时间
    std::thread::sleep(Duration::from_millis(500));
    let Some(window) = app.get_webview_window("main") else {
        return json!({ "ok": false, "fatal": "主窗口不存在", "steps": [] });
    };

    let mut steps = Vec::new();
    let mut all_ok = true;
    let exprs: Vec<&str> = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//") && !line.starts_with('#'))
        .collect();

    for (index, expr) in exprs.iter().enumerate() {
        // 统一包装：表达式结果包成 {ok, v}，求值异常包成 {ok:false, e}，
        // 两者都 JSON.stringify 后返回字符串——满足 eval_js 的返回值契约
        let wrapped = format!(
            "JSON.stringify((function(){{try{{return {{ok:true,v:({})}}}}catch(e){{return {{ok:false,e:String((e&&e.message)||e)}}}}}})())",
            expr
        );
        let outcome = match crate::export_native::eval_js(&window, &wrapped) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(value) => json!({
                    "index": index,
                    "expr": expr,
                    "ok": value.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "value": value.get("v").cloned().unwrap_or(Value::Null),
                    "error": value.get("e").cloned().unwrap_or(Value::Null),
                }),
                Err(err) => json!({
                    "index": index,
                    "expr": expr,
                    "ok": false,
                    "error": format!("结果非 JSON: {} / 原始: {}", err, raw),
                }),
            },
            Err(err) => json!({
                "index": index,
                "expr": expr,
                "ok": false,
                "error": format!("evaluateJavaScript: {}", err),
            }),
        };
        if !outcome.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            all_ok = false;
        }
        steps.push(outcome);
        if index + 1 < exprs.len() {
            std::thread::sleep(Duration::from_millis(step_delay));
        }
    }

    json!({ "ok": all_ok, "count": steps.len(), "steps": steps })
}
