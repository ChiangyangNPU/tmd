//! 自动更新（对齐 electron/updater.cjs 的渲染层契约）。
//!
//! 与 Electron 版的差异（均为有意取舍）：
//! - **不再自研双源/差量**：原语用 tauri-plugin-updater 承载——校验签名、
//!   下载、安装由插件负责；端点仍配双源（Gitee 优先、GitHub 备用，插件按序回退）
//! - **全量下载**：Electron 走 blockmap 差量，这里每次拉完整安装包（体积换简单）
//! - **一步式安装**：下载完成即安装并重启（Electron 分「下载→点重启安装」两步）；
//!   重启前仍走渲染层保存握手（tmd-doc-save-request / tmd-doc-save-result），
//!   未保存内容不会因更新丢失
//!
//! 签名公钥未配置时（tauri.conf.json plugins.updater.pubkey 为空）不崩：
//! 检查/下载都以 error 状态回报，文案指向配置步骤。
//!
//! @author chiangyang

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use semver::Version;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{RemoteRelease, UpdaterExt};

use crate::error::CmdError;
use crate::window_state;

/// 状态事件名（shim 的 onUpdateStatus 订阅）
pub const STATUS_EVENT: &str = "tmd-update-status";
/// 「保存并重启」握手：请求渲染层保存
pub const SAVE_REQUEST_EVENT: &str = "tmd-doc-save-request";

/// 更新器运行时状态
pub struct UpdaterState {
    /// 「启动时自动检查更新」开关（来自 shell-state.json，渲染层经 set_auto 同步）
    pub auto_check: AtomicBool,
    /// 检查/下载串行闸：避免自动检查与手动点击并发下载
    pub busy: AtomicBool,
    /// 「保存并重启」握手的回执通道（渲染层 reportSaveResult 触发）
    pub save_ack: Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
}

impl UpdaterState {
    pub fn new(auto_check: bool) -> Self {
        Self {
            auto_check: AtomicBool::new(auto_check),
            busy: AtomicBool::new(false),
            save_ack: Mutex::new(None),
        }
    }
}

fn emit_status(app: &AppHandle, status: Value) {
    // 渲染层尚未就绪时 emit 无人接收也无妨：状态是瞬时的，重开设置会重新检查
    let _ = app.emit(STATUS_EVENT, status);
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    emit_status(app, json!({ "status": "error", "message": message.into() }));
}

/// 配置里的签名公钥（空串 / 缺省视为未配置）
fn configured_pubkey(app: &AppHandle) -> Option<String> {
    let plugins = &app.config().plugins.0;
    let key = plugins
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

/// 公钥缺配置时的统一文案（含修复指引，避免用户以为功能坏了）
const NO_PUBKEY_HINT: &str =
    "未配置更新公钥：在 tauri.conf.json 的 plugins.updater.pubkey 填入公钥，\
     并用 TAURI_SIGNING_PRIVATE_KEY 打包含签名的安装包（见 docs/打包发布.md §11）";

/// 自定义「是否有更新」比较器：让同一 base（major.minor.patch）上的
/// `-Fix-N` 热修复被识别为比正式版更新，且 Fix 链内按数字递增。
///
/// 为什么需要：tauri-plugin-updater 默认用纯 semver 比较，而 semver 规定
/// 预发布版本优先级**低于**对应正式版——`0.2.3-Fix-1 < 0.2.3`，导致在已发
/// 正式版上叠的热修复永远不会被自动更新拉到。本比较器只对 `Fix` 标记的
/// 预发布放宽这条规则，其余预发布（beta / rc 等）仍遵循标准 semver，避免
/// 把测试版误推给正式版用户。
///
/// 语义（`current` = 当前安装版本，`release` = 远端版本）：
/// - base 不同 → 高 base 胜出（标准 semver，如 0.2.4 > 0.2.3-Fix-1）
/// - base 相同且远端是 Fix-N、当前是正式版 → 是更新（核心诉求）
/// - base 相同且两边都是 Fix → 比数字 N（Fix-2 > Fix-1，数字比较避开
///   `Fix-10` 字典序小于 `Fix-2` 的坑）
/// - base 相同且当前是 Fix-N、远端是正式版 → 标准 semver（正式版 > Fix）
/// - 其余预发布 → 标准 semver
pub(crate) fn tmd_is_update(current: &Version, release: &RemoteRelease) -> bool {
    version_is_newer(current, &release.version)
}

/// 纯版本比较（拆出以便单测，无需构造 RemoteRelease）
fn version_is_newer(current: &Version, remote: &Version) -> bool {
    // base 不同：高 base 胜出（标准 semver）
    if remote.major != current.major
        || remote.minor != current.minor
        || remote.patch != current.patch
    {
        return remote > current;
    }
    // base 相同：在 Fix 标记上做自定义序
    match (fix_num(remote), fix_num(current)) {
        (Some(rn), Some(cn)) => rn > cn,
        (Some(_), None) => true,
        (None, Some(_)) | (None, None) => remote > current,
    }
}

/// 从版本的预发布段解析 Fix 序号：`Fix-1` / `fix.2` / `FIX-10` → Some(N)；
/// 非 Fix 标记的预发布（beta / rc）或正式版返回 None，交由标准 semver 处理。
fn fix_num(v: &Version) -> Option<u64> {
    let pre = v.pre.as_str();
    if pre.is_empty() {
        return None;
    }
    let lower = pre.to_ascii_lowercase();
    let stem = lower.strip_prefix("fix")?;
    let num_part = stem.trim_start_matches(|c: char| c == '-' || c == '.');
    num_part.parse().ok()
}

/// 手动检查：检查 → 有新版本则弹原生对话框询问 → 同意后下载安装
#[tauri::command]
pub async fn tmd_update_check(app: AppHandle) -> Result<(), CmdError> {
    run_check(app).await.map_err(CmdError::from)
}

/// 直接下载（不经过对话框；供 UI 上「立即更新」类入口使用）
#[tauri::command]
pub async fn tmd_update_download(app: AppHandle) -> Result<(), CmdError> {
    let state = app.state::<UpdaterState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err(CmdError::internal("更新任务进行中"));
    }
    let result = download_and_install(app.clone()).await;
    state.busy.store(false, Ordering::SeqCst);
    result.map_err(CmdError::from)
}

/// 安装已下载的更新：本实现里安装与下载合并完成，此命令语义为「重启以生效」
#[tauri::command]
pub fn tmd_update_install(app: AppHandle) {
    app.restart();
}

/// 「启动时自动检查更新」开关：持久化到 shell-state.json（重启后仍生效）
#[tauri::command]
pub fn tmd_update_set_auto(app: AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        state.auto_check.store(enabled, Ordering::SeqCst);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        window_state::save_shell_state(
            &dir.join("shell-state.json"),
            json!({ "autoCheckUpdate": enabled }),
        );
    }
}

/// 「保存并重启」握手回执：渲染层保存结束后调用（ok=false 时仍重启——
/// 安装包已就位，用户放弃保存的语义是「不要因此卡住更新」）
#[tauri::command]
pub fn tmd_doc_save_result(app: AppHandle, ok: bool) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        if let Ok(mut slot) = state.save_ack.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(ok);
            }
        }
    }
}

/// 启动 5 秒后自动检查（对应 Electron scheduleAutoCheck）
pub fn schedule_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let enabled = app
            .try_state::<UpdaterState>()
            .map(|s| s.auto_check.load(Ordering::SeqCst))
            .unwrap_or(false);
        if enabled {
            // 公钥未配置时跳过自动检查：否则每次启动都静默报一条错误，
            // 而用户没有可见的修复入口（手动点击仍会给出完整指引）
            if configured_pubkey(&app).is_none() {
                return;
            }
            let _ = run_check(app).await;
        }
    });
}

/// 检查并（用户同意后）下载安装
async fn run_check(app: AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("更新任务进行中".into());
    }
    // 用闭包收尾，保证任何早退分支都释放闸门
    let outcome = check_inner(app.clone()).await;
    state.busy.store(false, Ordering::SeqCst);
    outcome
}

async fn check_inner(app: AppHandle) -> Result<(), String> {
    let Some(_) = configured_pubkey(&app) else {
        emit_error(&app, NO_PUBKEY_HINT);
        return Err(NO_PUBKEY_HINT.into());
    };
    emit_status(&app, json!({ "status": "checking" }));

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            let msg = format!("更新器初始化失败: {err}");
            emit_error(&app, &msg);
            return Err(msg);
        }
    };
    let update = match updater.check().await {
        Ok(found) => found,
        Err(err) => {
            let msg = format!("检查更新失败: {err}");
            emit_error(&app, &msg);
            return Err(msg);
        }
    };
    let Some(update) = update else {
        emit_status(&app, json!({ "status": "not-available" }));
        return Ok(());
    };

    emit_status(
        &app,
        json!({
            "status": "available",
            "version": update.version,
            "releaseNotes": update.body,
        }),
    );

    // 原生对话框询问下载（对应 Electron update-available 的 showMessageBox）；
    // OK=下载安装，Cancel=稍后
    let app_for_dialog = app.clone();
    app.dialog()
        .message(format!(
            "发现新版本 {}。是否立即下载并安装？安装完成后应用会自动重启。",
            update.version
        ))
        .title("TMD 更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "下载并安装".into(),
            "稍后".into(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            let app = app_for_dialog.clone();
            tauri::async_runtime::spawn(async move {
                let _ = download_and_install_with_guard(app).await;
            });
        });
    Ok(())
}

async fn download_and_install_with_guard(app: AppHandle) -> Result<(), String> {
    // 闸门借用必须收在块内：State 是 app 的借用，跨 await 持有会挡住 app 的移动
    {
        let state = app.state::<UpdaterState>();
        if state.busy.swap(true, Ordering::SeqCst) {
            return Err("更新任务进行中".into());
        }
    }
    let result = download_and_install(app.clone()).await;
    if let Some(state) = app.try_state::<UpdaterState>() {
        state.busy.store(false, Ordering::SeqCst);
    }
    result
}

/// 下载 + 安装 + 保存握手 + 重启
async fn download_and_install(app: AppHandle) -> Result<(), String> {
    if configured_pubkey(&app).is_none() {
        emit_error(&app, NO_PUBKEY_HINT);
        return Err(NO_PUBKEY_HINT.into());
    }
    emit_status(&app, json!({ "status": "downloading", "percent": 0 }));

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            let msg = format!("更新器初始化失败: {err}");
            emit_error(&app, &msg);
            return Err(msg);
        }
    };
    let Some(update) = (match updater.check().await {
        Ok(found) => found,
        Err(err) => {
            let msg = format!("检查更新失败: {err}");
            emit_error(&app, &msg);
            return Err(msg);
        }
    }) else {
        emit_status(&app, json!({ "status": "not-available" }));
        return Ok(());
    };

    // 进度节流：百分比变化 ≥1 才推一次事件（避免每 chunk 一次 IPC）
    let progress_app = app.clone();
    let mut last_percent: i64 = -1;
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                let Some(total) = content_len.filter(|t| *t > 0) else {
                    return;
                };
                let pct = ((downloaded as f64 / total as f64) * 100.0).round() as i64;
                if pct != last_percent {
                    last_percent = pct;
                    let _ = progress_app.emit(
                        STATUS_EVENT,
                        json!({ "status": "downloading", "percent": pct }),
                    );
                }
            },
            || {},
        )
        .await;

    if let Err(err) = result {
        let msg = format!("下载/安装失败: {err}");
        emit_error(&app, &msg);
        return Err(msg);
    }

    emit_status(&app, json!({ "status": "downloaded" }));
    // 重启前保存握手：给渲染层 5 秒落盘窗口（无未保存内容时通常秒回）
    wait_renderer_saved(&app).await;
    app.restart();
}

/// 「保存并重启」握手：发事件 → 等回执 → 超时放行
async fn wait_renderer_saved(app: &AppHandle) {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let stored = app.try_state::<UpdaterState>().and_then(|state| {
        state.save_ack.lock().ok().map(|mut slot| {
            *slot = Some(tx);
        })
    });
    if stored.is_none() {
        return;
    }
    let _ = app.emit(SAVE_REQUEST_EVENT, ());
    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|e| panic!("解析版本 {s} 失败: {e}"))
    }

    /// (当前版本, 远端版本, 期望是否有更新)
    const CASES: &[(&str, &str, bool)] = &[
        // 核心诉求：正式版上叠 Fix 热修复 → 有更新
        ("0.2.3", "0.2.3-Fix-1", true),
        ("0.2.3", "0.2.3-Fix-10", true),
        // Fix 链内数字递增
        ("0.2.3-Fix-1", "0.2.3-Fix-2", true),
        ("0.2.3-Fix-1", "0.2.3-Fix-10", true),
        // 数字比较（非字典序）：Fix-10 > Fix-2
        ("0.2.3-Fix-2", "0.2.3-Fix-10", true),
        // 倒退 / 相等 → 无更新
        ("0.2.3-Fix-2", "0.2.3-Fix-1", false),
        ("0.2.3-Fix-10", "0.2.3-Fix-2", false),
        ("0.2.3-Fix-1", "0.2.3-Fix-1", false),
        ("0.2.3", "0.2.3", false),
        // 当前是 Fix、远端是正式版 → 正式版更高，算更新
        ("0.2.3-Fix-1", "0.2.3", true),
        // base 不同：标准 semver
        ("0.2.3", "0.2.4", true),
        ("0.1.8", "0.2.0", true),
        ("0.2.4", "0.2.3-Fix-5", false), // 高 base 不会被低 base 的 Fix 拉低
        // 非 Fix 预发布：不推给正式版用户（标准 semver，beta < 正式版）
        ("0.2.3", "0.2.3-beta", false),
        ("0.2.3", "0.2.3-rc.1", false),
        // 大小写 / 分隔符兼容
        ("0.2.3", "0.2.3-fix.1", true),
        ("0.2.3", "0.2.3-FIX-1", true),
        // 远端带 v 前缀不会出现（插件解析时已剥离），这里只验不带 v 的路径
    ];

    #[test]
    fn version_is_newer_matrix() {
        for (current, remote, expected) in CASES {
            assert_eq!(
                version_is_newer(&v(current), &v(remote)),
                *expected,
                "current={current} remote={remote} 期望 {expected}",
            );
        }
    }

    #[test]
    fn fix_num_parsing() {
        assert_eq!(fix_num(&v("0.2.3")), None);
        assert_eq!(fix_num(&v("0.2.3-Fix-1")), Some(1));
        assert_eq!(fix_num(&v("0.2.3-fix.2")), Some(2));
        assert_eq!(fix_num(&v("0.2.3-FIX-10")), Some(10));
        assert_eq!(fix_num(&v("0.2.3-beta")), None);
        assert_eq!(fix_num(&v("0.2.3-fix")), None); // 无数字
        assert_eq!(fix_num(&v("0.2.3-fix-abc")), None); // 非数字
    }
}
