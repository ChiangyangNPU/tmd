//! AI 助手 IPC（electron/ipc-ai.cjs 的 Rust 对应）。
//!
//! 安全边界（与 JS 版一致）：
//! - 渲染层永远拿不到明文 Key，只能得到 hasApiKey
//! - messages / texts 由渲染层提供，壳层做角色白名单与体积上限校验后才发往网络
//! - 对话采用「invoke 立即返回 + tmd-ai-stream 事件流」：长响应不阻塞 invoke，
//!   渲染层用 requestId 关联增量事件；用户可随时经 abortAi 中止

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::ai_client::{self, AiClientState, StreamEvent};
use crate::ai_config::{AiConfigState, ClientConfig};

#[derive(Serialize)]
pub(crate) struct AiErrorBody {
    pub code: String,
    pub message: String,
}

/// tmd_ai_chat 的返回形状（禁用/参数非法时 ok=false，不抛异常）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiChatStart {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AiErrorBody>,
}

/// AI 配置 + 客户端（Tauri managed state）
pub(crate) struct AiState {
    pub config: AiConfigState,
    pub client: AiClientState,
}

impl AiState {
    pub fn new(config_file: std::path::PathBuf) -> Self {
        AiState {
            config: AiConfigState::new(config_file),
            client: AiClientState::new(),
        }
    }
}

/// 对应 native.ts getAiConfig：配置视图（不含明文 Key）
#[tauri::command]
pub(crate) fn tmd_ai_get_config(state: tauri::State<'_, AiState>) -> Value {
    state.config.public_view()
}

/// 对应 native.ts saveAiConfig：保存增量并返回最新视图
#[tauri::command]
pub(crate) fn tmd_ai_save_config(state: tauri::State<'_, AiState>, patch: Value) -> Value {
    state.config.save(&patch)
}

/// 对应 native.ts testAiConnection：连通性测试（overrides 为尚未保存的表单值）
#[tauri::command]
pub(crate) async fn tmd_ai_test(
    state: tauri::State<'_, AiState>,
    overrides: Value,
) -> Result<Value, ()> {
    let cfg: ClientConfig = state.config.get_client_config(&overrides);
    Ok(state.client.test_connection(&cfg).await)
}

/// 对应 native.ts chatAi：发起流式对话（立即返回，增量经 tmd-ai-stream 推送）。
#[tauri::command]
pub(crate) fn tmd_ai_chat(
    app: tauri::AppHandle,
    state: tauri::State<'_, AiState>,
    request: Value,
) -> AiChatStart {
    let (settings, _) = state.config.read();
    if !settings.enabled {
        return AiChatStart {
            ok: false,
            request_id: None,
            error: Some(AiErrorBody {
                code: "disabled".into(),
                message: "AI assistant is disabled".into(),
            }),
        };
    }
    let Some(request_id) = request
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect::<String>())
    else {
        return AiChatStart {
            ok: false,
            request_id: None,
            error: Some(AiErrorBody {
                code: "bad-request".into(),
                message: "Invalid request id".into(),
            }),
        };
    };
    let messages = match ai_client::sanitize_messages(request.get("messages").unwrap_or(&Value::Null))
    {
        Ok(m) => m,
        Err(message) => {
            return AiChatStart {
                ok: false,
                request_id: None,
                error: Some(AiErrorBody { code: "bad-request".into(), message }),
            }
        }
    };

    // 异步执行流式请求：结果与异常都通过事件流回到渲染层
    let cfg = state.config.get_client_config(&Value::Null);
    let client_task_id = request_id.clone();
    let emit_request_id = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AiState>();
        let app_for_event = app.clone();
        let on_event = move |event: StreamEvent| {
            let payload = match serde_json::to_value(event) {
                Ok(mut v) => {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("requestId".into(), Value::String(emit_request_id.clone()));
                    }
                    v
                }
                Err(_) => return,
            };
            let _ = app_for_event.emit("tmd-ai-stream", payload);
        };
        if let Err(err) = state.client.chat(&cfg, &client_task_id, &messages, on_event).await {
            let _ = app.emit(
                "tmd-ai-stream",
                serde_json::json!({
                    "requestId": client_task_id,
                    "type": "error",
                    "code": err.code,
                    "message": err.message,
                }),
            );
        }
    });
    AiChatStart { ok: true, request_id: Some(request_id), error: None }
}

/// 对应 native.ts abortAi：中止在途请求，返回是否命中。
#[tauri::command]
pub(crate) fn tmd_ai_abort(state: tauri::State<'_, AiState>, request_id: String) -> bool {
    if request_id.is_empty() {
        return false;
    }
    state.client.abort(&request_id)
}

/// 对应 native.ts embedAiTexts：向量嵌入（结构化结果，渲染层据此回退关键词检索）。
#[tauri::command]
pub(crate) async fn tmd_ai_embed(
    state: tauri::State<'_, AiState>,
    texts: Value,
) -> Result<Value, ()> {
    let (settings, _) = state.config.read();
    if !settings.enabled {
        return Ok(serde_json::json!({
            "ok": false,
            "error": { "code": "disabled", "message": "AI assistant is disabled" }
        }));
    }
    let sanitized = match ai_client::sanitize_texts(&texts) {
        Ok(t) => t,
        Err(message) => {
            return Ok(serde_json::json!({
                "ok": false,
                "error": { "code": "bad-request", "message": message }
            }))
        }
    };
    let cfg = state.config.get_client_config(&Value::Null);
    Ok(match state.client.embed(&cfg, &sanitized).await {
        Ok(vectors) => serde_json::json!({ "ok": true, "vectors": vectors }),
        Err(err) => serde_json::json!({
            "ok": false,
            "error": { "code": err.code, "message": err.message }
        }),
    })
}
