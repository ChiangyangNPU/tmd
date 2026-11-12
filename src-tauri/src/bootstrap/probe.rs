//! spike 验收探针：环境变量触发的自动验证（TMD_SPIKE_*）与菜单调试动作。
//! 均为 spike 期工具，随对应验收完成逐块移除；门控与原 bootstrap.rs 保持
//! 一致（部分块 release 也响应——菜单项在发布包注册，分支必须同在）。

#[cfg(any(target_os = "macos", windows))]
use crate::export_native;
#[cfg(target_os = "macos")]
#[cfg(any(debug_assertions, feature = "dev-tools"))]
use crate::export_probe;
// Manager（get_webview_window）与 logger 仅 macOS 专属块使用
#[cfg(target_os = "macos")]
use tauri::Manager;

use crate::exporter;
#[cfg(target_os = "macos")]
use crate::logger;

/// setup 末尾启动的环境变量探针（原 setup 闭包内四块，顺序保持）。
pub(crate) fn spawn_env_probes(app: &tauri::AppHandle) {
    // spike 阶段 B 后续：导出窗口形态矩阵自动验证（TMD_SPIKE_MATRIX=1）。
    // 不依赖主窗口内容，5s 后直接跑；须以 `open -a --env TMD_SPIKE_MATRIX=1`
    // 触发——直接后台启动的应用未激活，其窗口不合成（阶段 B 可见性约束）
    #[cfg(any(debug_assertions, feature = "dev-tools"))]
    if std::env::var("TMD_SPIKE_MATRIX").as_deref() == Ok("1") {
        #[cfg(target_os = "macos")]
        {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                export_probe::run_matrix(&app);
            });
        }
    }
    // spike 正式导出链端到端验证（TMD_SPIKE_EXPORT_RUN=1）：
    // 最小 longimage 任务走真实链路（探边窗/桥接/分段截图/拼接），
    // 产物 /tmp/tmd-export-verify.png；须 open -a 触发（应用激活）
    if std::env::var("TMD_SPIKE_EXPORT_RUN").as_deref() == Ok("1") {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            exporter::verify::verify_pipeline(&app);
        });
    }
    // Windows 原语三件套自测（视口截帧 / 区域裁剪 / PDF）：
    // 产物与像素统计落临时目录 + 日志，用于首落地验收（发布前移除）
    #[cfg(windows)]
    if std::env::var("TMD_SPIKE_EXPORT_OPS").as_deref() == Ok("1") {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            export_native::verify_native(&app);
        });
    }
    // spike 阶段 B 原型自动验证：仅当 TMD_SPIKE_EXPORT=1 时启用
    // （启动 8 秒后文档已加载，执行全文档 PDF + 视口截图原语）
    if std::env::var("TMD_SPIKE_EXPORT").as_deref() == Ok("1") {
        #[cfg(target_os = "macos")]
        {
            let app = app.clone();
            std::thread::spawn(move || {
                let step = |msg: &str| {
                    eprintln!("[tmd-spike] {}", msg);
                    if let Some(logger) = logger::global() {
                        logger.log(
                            "warn",
                            "main",
                            &format!("阶段B原型: {}", msg),
                            None,
                            &logger::LogMeta::default(),
                        );
                    }
                };
                std::thread::sleep(std::time::Duration::from_secs(8));
                step("step1: 开始（8s 延迟结束）");
                let Some(window) = app.get_webview_window("main") else {
                    step("窗口不存在");
                    return;
                };
                step("step2: read_content_metrics 前");
                let metrics = export_native::read_content_metrics(&window);
                step(&format!(
                    "step3: metrics={:?}（若 Err 则崩溃点在 evaluate）",
                    metrics.is_ok()
                ));
                let pdf = metrics.and_then(|(w, h)| {
                    step(&format!("step4: capture_full_pdf 前（{}x{}）", w, h));
                    export_native::capture_full_pdf(&window, w, h, None).and_then(|bytes| {
                        std::fs::write("/tmp/tmd-spike-export.pdf", &bytes)
                            .map_err(|e| e.to_string())?;
                        step(&format!("step5: PDF 落盘 {} 字节", bytes.len()));
                        Ok(format!("PDF {} 字节（内容 {}x{}）", bytes.len(), w, h))
                    })
                });
                let png = export_native::capture_viewport_png(&window).and_then(|bytes| {
                    std::fs::write("/tmp/tmd-spike-export.png", &bytes)
                        .map_err(|e| e.to_string())?;
                    step(&format!("step6: PNG 落盘 {} 字节", bytes.len()));
                    Ok(format!("PNG {} 字节", bytes.len()))
                });
                step(&format!("step7: 完成 PDF={:?} PNG={:?}", pdf, png));
            });
        }
    }
}

/// 菜单「导窗形态矩阵」（debug/dev-tools 构建才有菜单项）：直接跑矩阵。
#[cfg(any(debug_assertions, feature = "dev-tools"))]
#[allow(unused_variables)] // 仅 macOS 有矩阵实现，其余平台参数整体闲置
pub(crate) fn run_export_window_matrix(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        std::thread::spawn(move || export_probe::run_matrix(&app));
    }
}

/// 菜单「全文档 PDF 导出 / 视口截图」：Rust 侧直接驱动 WKWebView 原语
/// （不经渲染层），产物落 /tmp 并写日志。is_pdf=false 为视口截图。
#[allow(unused_variables)] // Windows 下无 WKWebView 原语，参数整体闲置
pub(crate) fn run_spike_proto(app: &tauri::AppHandle, is_pdf: bool) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let result = if is_pdf {
                export_native::read_content_metrics(&window).and_then(|(w, h)| {
                    let bytes = export_native::capture_full_pdf(&window, w, h, None)?;
                    let out = std::path::Path::new("/tmp/tmd-spike-export.pdf");
                    std::fs::write(out, &bytes).map_err(|e| e.to_string())?;
                    Ok(format!(
                        "/tmp/tmd-spike-export.pdf（{} 字节, 内容 {}×{}）",
                        bytes.len(),
                        w,
                        h
                    ))
                })
            } else {
                export_native::capture_viewport_png(&window).and_then(|bytes| {
                    let out = std::path::Path::new("/tmp/tmd-spike-export.png");
                    std::fs::write(out, &bytes).map_err(|e| e.to_string())?;
                    Ok(format!("/tmp/tmd-spike-export.png（{} 字节）", bytes.len()))
                })
            };
            match result {
                Ok(msg) => {
                    eprintln!("[tmd-spike] 原型成功: {}", msg);
                    if let Some(logger) = logger::global() {
                        logger.log(
                            "warn",
                            "main",
                            &format!("spike 原型成功: {}", msg),
                            None,
                            &logger::LogMeta::default(),
                        );
                    }
                }
                Err(err) => {
                    eprintln!("[tmd-spike] 原型失败: {}", err);
                    if let Some(logger) = logger::global() {
                        logger.log(
                            "error",
                            "main",
                            &format!("spike 原型失败: {}", err),
                            None,
                            &logger::LogMeta::default(),
                        );
                    }
                }
            }
        });
    }
}
