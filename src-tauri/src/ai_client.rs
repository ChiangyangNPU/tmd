//! AI 请求客户端（electron/ai-client.cjs 的 Rust 移植）。
//!
//! 全部「OpenAI 兼容」服务商共用一套实现：POST {baseUrl}/chat/completions
//! 与 POST {baseUrl}/embeddings。与 JS 版逐项对齐：
//! - 增量 SSE 解析：行缓冲容忍任意 chunk 边界；兼容 CRLF；`data: [DONE]`；
//!   非 JSON 的 data 行（网关保活）忽略
//! - HTTP 状态码 → 内部错误码归一化；错误信息尽量提取可读文本
//! - 空闲超时：流式响应 60s 无新数据即中止（思考型模型首字可能较慢）
//! - 按 requestId 管理取消（AbortController → CancellationToken）
//! - 对话流事件 delta / reasoning / done；上游流内 error 结构归一化
//! - 嵌入响应按 index 逐条校验（上游结构不可信）
//!
//! 网络只发生在壳层：渲染层拿不到 API Key。
//!
//! @author chiangyang

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// 流式请求的空闲超时（思考型模型首字可能较慢）
pub(crate) const IDLE_TIMEOUT_MS: u64 = 60_000;
/// 连通性测试的整体超时
const TEST_TIMEOUT_MS: u64 = 20_000;
/// 向量嵌入的整体超时（非流式一次性请求，无增量可续）
const EMBED_TIMEOUT_MS: u64 = 60_000;

// ---------- IPC 层入参校验（electron/ipc-ai.cjs 对应） ----------

pub(crate) const MAX_MESSAGE_CHARS: usize = 100_000;
pub(crate) const MAX_TOTAL_CHARS: usize = 400_000;
pub(crate) const MAX_MESSAGES: usize = 100;
pub(crate) const MAX_EMBED_TEXT_CHARS: usize = 8_000;
pub(crate) const MAX_EMBED_TOTAL_CHARS: usize = 100_000;
pub(crate) const MAX_EMBED_TEXTS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 校验并裁剪对话消息（角色白名单 + 双层体积上限）
pub(crate) fn sanitize_messages(raw: &Value) -> Result<Vec<ChatMessage>, String> {
    let Some(items) = raw.as_array() else {
        return Err("invalid messages".into());
    };
    if items.is_empty() {
        return Err("invalid messages".into());
    }
    if items.len() > MAX_MESSAGES {
        return Err("too many messages".into());
    }
    let mut total = 0usize;
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
        if !matches!(role, "system" | "user" | "assistant") {
            return Err("invalid role".into());
        }
        let content = item
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if content.is_empty() {
            return Err("invalid content".into());
        }
        if content.len() > MAX_MESSAGE_CHARS {
            return Err("message too large".into());
        }
        total += content.len();
        if total > MAX_TOTAL_CHARS {
            return Err("request too large".into());
        }
        result.push(ChatMessage {
            role: role.into(),
            content: content.into(),
        });
    }
    Ok(result)
}

/// 校验嵌入文本列表（数量与双层体积上限）
pub(crate) fn sanitize_texts(raw: &Value) -> Result<Vec<String>, String> {
    let Some(items) = raw.as_array() else {
        return Err("invalid texts".into());
    };
    if items.is_empty() {
        return Err("invalid texts".into());
    }
    if items.len() > MAX_EMBED_TEXTS {
        return Err("too many texts".into());
    }
    let mut total = 0usize;
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err("invalid text".into());
        };
        if text.is_empty() {
            return Err("invalid text".into());
        }
        if text.len() > MAX_EMBED_TEXT_CHARS {
            return Err("text too large".into());
        }
        total += text.len();
        if total > MAX_EMBED_TOTAL_CHARS {
            return Err("request too large".into());
        }
        result.push(text.to_string());
    }
    Ok(result)
}

// ---------- 带错误码的错误 ----------

#[derive(Debug, Clone)]
pub(crate) struct AiError {
    pub code: String,
    pub message: String,
}

impl AiError {
    /// 构造带错误码的 AI 错误
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        AiError {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// 增量 SSE 解析器（与 JS createSseParser 对齐；输入可能以任意边界切分）
#[derive(Default)]
pub(crate) struct SseParser {
    buffer: String,
}

pub(crate) enum SseItem {
    Data(Value),
    Done,
}

impl SseParser {
    /// 创建客户端（共享连接池 + 空的在途请求表）
    pub fn new() -> Self {
        SseParser {
            buffer: String::new(),
        }
    }

    /// 消费一行：`data:` 前缀 + [DONE] + JSON；其余忽略
    fn consume_line<F: FnMut(SseItem)>(&mut self, line: &str, on_event: &mut F) {
        let trimmed = line.strip_suffix('\r').unwrap_or(line);
        let Some(payload) = trimmed.strip_prefix("data:") else {
            return;
        };
        let payload = payload.trim();
        if payload.is_empty() {
            return;
        }
        if payload == "[DONE]" {
            on_event(SseItem::Done);
            return;
        }
        if let Ok(data) = serde_json::from_str::<Value>(payload) {
            on_event(SseItem::Data(data));
        }
        // 非 JSON 的 data 行（部分网关的保活注释）直接忽略
    }

    /// 喂入一个网络分块；行缓冲保证跨 chunk 的行被正确拼接
    pub fn push<F: FnMut(SseItem)>(&mut self, chunk: &str, on_event: &mut F) {
        self.buffer.push_str(chunk);
        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].to_string();
            self.buffer = self.buffer[index + 1..].to_string();
            self.consume_line(&line, on_event);
        }
    }

    /// 流结束时处理没有换行符结尾的最后一行
    pub fn flush<F: FnMut(SseItem)>(&mut self, on_event: &mut F) {
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            self.consume_line(&rest, on_event);
        }
    }
}

/// HTTP 状态码 → 内部错误码
pub(crate) fn code_for_status(status: u16) -> &'static str {
    match status {
        401 | 403 => "unauthorized",
        404 => "not-found",
        408 => "timeout",
        429 => "rate-limited",
        s if s >= 500 => "server-error",
        _ => "bad-request",
    }
}

/// 从失败响应中提取错误信息（各服务商结构不一，尽量给出可读文本）
pub(crate) fn read_error_message(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    if let Ok(data) = serde_json::from_str::<Value>(text) {
        let from_error = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str);
        let from_message = data.get("message").and_then(Value::as_str);
        if let Some(m) = from_error.or(from_message) {
            return m.to_string();
        }
    }
    text.chars().take(300).collect()
}

/// 客户端向调用方推送的流式事件（IPC 层附加 requestId 后转发渲染层）
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum StreamEvent {
    Delta { text: String },
    Reasoning { text: String },
    Done,
}

/// AI 客户端状态：共享 HTTP 连接池 + 在途请求的取消句柄
pub(crate) struct AiClientState {
    http: reqwest::Client,
    tasks: Mutex<HashMap<String, CancellationToken>>,
}

fn assert_config(cfg: &crate::ai_config::ClientConfig, require_key: bool) -> Result<(), AiError> {
    if cfg.base_url.is_empty() {
        return Err(AiError::new(
            "not-configured",
            "API base URL is not configured",
        ));
    }
    if cfg.model.is_empty() {
        return Err(AiError::new("not-configured", "Model is not configured"));
    }
    if require_key && cfg.needs_key && cfg.api_key.is_empty() {
        return Err(AiError::new("no-api-key", "API key is not configured"));
    }
    Ok(())
}

impl AiClientState {
    /// 创建空的增量 SSE 解析器
    pub fn new() -> Self {
        AiClientState {
            http: reqwest::Client::new(),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    fn endpoint(
        cfg: &crate::ai_config::ClientConfig,
        path: &str,
    ) -> (String, Vec<(String, String)>) {
        let mut headers = vec![("Content-Type".into(), "application/json".into())];
        if !cfg.api_key.is_empty() {
            headers.push(("Authorization".into(), format!("Bearer {}", cfg.api_key)));
        }
        if path.ends_with("chat/completions") {
            headers.push(("Accept".into(), "text/event-stream".into()));
        }
        let url = format!("{}/{}", cfg.base_url.trim_end_matches('/'), path);
        (url, headers)
    }

    async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &Value,
        token: &CancellationToken,
    ) -> Result<reqwest::Response, AiError> {
        let mut req = self.http.post(url);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let fut = req.body(body.to_string()).send();
        tokio::select! {
            _ = token.cancelled() => Err(AiError::new("cancelled", "Request cancelled")),
            res = fut => res.map_err(|err| AiError::new("network", err.to_string())),
        }
    }

    /// 发起一次流式对话；事件经 on_event 实时回调，成功返回完整文本。
    pub(crate) async fn chat<F: Fn(StreamEvent)>(
        &self,
        cfg: &crate::ai_config::ClientConfig,
        request_id: &str,
        messages: &[ChatMessage],
        on_event: F,
    ) -> Result<String, AiError> {
        assert_config(cfg, true)?;
        let token = CancellationToken::new();
        self.tasks
            .lock()
            .expect("ai tasks 锁中毒")
            .insert(request_id.to_string(), token.clone());

        let result = self.chat_inner(cfg, messages, &on_event, &token).await;
        self.tasks
            .lock()
            .expect("ai tasks 锁中毒")
            .remove(request_id);
        result
    }

    async fn chat_inner<F: Fn(StreamEvent)>(
        &self,
        cfg: &crate::ai_config::ClientConfig,
        messages: &[ChatMessage],
        on_event: &F,
        token: &CancellationToken,
    ) -> Result<String, AiError> {
        let (url, headers) = Self::endpoint(cfg, "chat/completions");
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": messages,
            "temperature": cfg.temperature,
            "stream": cfg.streaming,
        });
        let res = self.post(&url, &headers, &body, token).await?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            let text = res.text().await.unwrap_or_default();
            let message = read_error_message(&text);
            return Err(AiError::new(
                code_for_status(status),
                if message.is_empty() {
                    format!("HTTP {}", status)
                } else {
                    message
                },
            ));
        }

        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        // 非流式响应（stream:false 或服务商忽略 stream）：一次性读取 JSON
        if !content_type.contains("text/event-stream") {
            let json = tokio::select! {
                _ = token.cancelled() => return Err(AiError::new("cancelled", "Request cancelled")),
                r = res.text() => match r {
                    Ok(t) => t,
                    Err(err) => return Err(AiError::new("bad-response", err.to_string())),
                },
            };
            let data: Value = serde_json::from_str(&json)
                .map_err(|err| AiError::new("bad-response", err.to_string()))?;
            let content = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str);
            let Some(content) = content else {
                return Err(AiError::new(
                    "bad-response",
                    "Missing message content in response",
                ));
            };
            on_event(StreamEvent::Delta {
                text: content.to_string(),
            });
            on_event(StreamEvent::Done);
            return Ok(content.to_string());
        }

        // 流式：逐 chunk 解析 SSE，60s 无新数据即中止
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::new();
        let mut content = String::new();
        let stream_error = Arc::new(std::sync::Mutex::new(None::<AiError>));
        let stream_error_writer = Arc::clone(&stream_error);
        let mut on_sse = |item: SseItem| {
            match item {
                SseItem::Done => on_event(StreamEvent::Done),
                SseItem::Data(data) => {
                    // 逐字段运行时校验：上游网关返回结构不完全可信
                    if let Some(err) = data.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Upstream stream error");
                        *stream_error_writer.lock().expect("stream error 锁中毒") =
                            Some(AiError::new("server-error", msg));
                        return;
                    }
                    let Some(delta) = data
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .filter(|d| d.is_object())
                    else {
                        return;
                    };
                    if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str)
                    {
                        if !reasoning.is_empty() {
                            on_event(StreamEvent::Reasoning {
                                text: reasoning.to_string(),
                            });
                        }
                    }
                    if let Some(text) = delta.get("content").and_then(Value::as_str) {
                        if !text.is_empty() {
                            content.push_str(text);
                            on_event(StreamEvent::Delta {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
        };

        loop {
            let next = tokio::select! {
                _ = token.cancelled() => {
                    return Err(AiError::new("cancelled", "Request cancelled"));
                }
                chunk = tokio::time::timeout(Duration::from_millis(IDLE_TIMEOUT_MS), stream.next()) => {
                    match chunk {
                        Err(_) => return Err(AiError::new("timeout", "Request timed out")),
                        Ok(None) => break,
                        Ok(Some(Err(err))) => return Err(AiError::new("network", err.to_string())),
                        Ok(Some(Ok(bytes))) => bytes,
                    }
                }
            };
            let text = String::from_utf8_lossy(&next).into_owned();
            parser.push(&text, &mut on_sse);
            if stream_error.lock().expect("stream error 锁中毒").is_some() {
                break;
            }
        }
        parser.flush(&mut on_sse);
        if let Some(err) = stream_error.lock().expect("stream error 锁中毒").take() {
            return Err(err);
        }
        Ok(content)
    }

    /// 连通性测试的完整流程（含请求）：返回结构化结果，不抛错。
    pub(crate) async fn test_connection(&self, cfg: &crate::ai_config::ClientConfig) -> Value {
        let started = Instant::now();
        let latency = || started.elapsed().as_millis() as u64;
        if let Err(err) = assert_config(cfg, true) {
            return serde_json::json!({ "ok": false, "code": err.code, "message": err.message, "latencyMs": latency() });
        }
        let (url, headers) = Self::endpoint(cfg, "chat/completions");
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 8,
            "stream": false,
        });
        let token = CancellationToken::new();
        let timeout_fut = tokio::time::timeout(Duration::from_millis(TEST_TIMEOUT_MS), async {
            self.post(&url, &headers, &body, &token).await
        });
        tokio::select! {
            _ = token.cancelled() => serde_json::json!({ "ok": false, "code": "timeout", "message": "Request timed out", "latencyMs": latency() }),
            res = timeout_fut => match res {
                Err(_) => serde_json::json!({ "ok": false, "code": "timeout", "message": "Request timed out", "latencyMs": latency() }),
                Ok(Err(err)) => serde_json::json!({ "ok": false, "code": err.code, "message": err.message, "latencyMs": latency() }),
                Ok(Ok(res)) => {
                    let status = res.status().as_u16();
                    if !(200..300).contains(&status) {
                        let text = res.text().await.unwrap_or_default();
                        let message = read_error_message(&text);
                        return serde_json::json!({ "ok": false, "code": code_for_status(status), "message": if message.is_empty() { format!("HTTP {}", status) } else { message }, "latencyMs": latency() });
                    }
                    // 读完响应体，确保连接正常释放
                    let _ = res.text().await;
                    serde_json::json!({ "ok": true, "latencyMs": latency() })
                }
            },
        }
    }

    /// 向量嵌入：非流式一次性请求，按输入顺序返回（index 逐条校验）。
    pub(crate) async fn embed(
        &self,
        cfg: &crate::ai_config::ClientConfig,
        texts: &[String],
    ) -> Result<Vec<Vec<f64>>, AiError> {
        if cfg.base_url.is_empty() {
            return Err(AiError::new(
                "not-configured",
                "API base URL is not configured",
            ));
        }
        if cfg.embed_model.is_empty() {
            return Err(AiError::new(
                "not-configured",
                "Embedding model is not configured",
            ));
        }
        if cfg.needs_key && cfg.api_key.is_empty() {
            return Err(AiError::new("no-api-key", "API key is not configured"));
        }
        let (url, headers) = Self::endpoint(cfg, "embeddings");
        let body = serde_json::json!({ "model": cfg.embed_model, "input": texts });
        let token = CancellationToken::new();
        let fut = async {
            let res = self.post(&url, &headers, &body, &token).await?;
            let status = res.status().as_u16();
            if !(200..300).contains(&status) {
                let text = res.text().await.unwrap_or_default();
                let message = read_error_message(&text);
                return Err(AiError::new(
                    code_for_status(status),
                    if message.is_empty() {
                        format!("HTTP {}", status)
                    } else {
                        message
                    },
                ));
            }
            let text = res
                .text()
                .await
                .map_err(|err| AiError::new("bad-response", err.to_string()))?;
            let data: Value = serde_json::from_str(&text)
                .map_err(|err| AiError::new("bad-response", err.to_string()))?;
            // 各服务商以 index 标注输入对应关系；逐条运行时校验（上游结构不可信）
            let Some(rows) = data.get("data").and_then(Value::as_array) else {
                return Err(AiError::new(
                    "bad-response",
                    "Unexpected embeddings response shape",
                ));
            };
            if rows.len() != texts.len() {
                return Err(AiError::new(
                    "bad-response",
                    "Unexpected embeddings response shape",
                ));
            }
            let mut vectors: Vec<Option<Vec<f64>>> = (0..texts.len()).map(|_| None).collect();
            for row in rows {
                let vec = row.get("embedding").and_then(Value::as_array);
                let Some(vec) = vec else {
                    return Err(AiError::new("bad-response", "Invalid embedding vector"));
                };
                if vec.is_empty() {
                    return Err(AiError::new("bad-response", "Invalid embedding vector"));
                }
                let mut parsed = Vec::with_capacity(vec.len());
                for n in vec {
                    let Some(n) = n.as_f64().filter(|f| f.is_finite()) else {
                        return Err(AiError::new("bad-response", "Invalid embedding vector"));
                    };
                    parsed.push(n);
                }
                let index = row.get("index").and_then(Value::as_u64).unwrap_or(u64::MAX) as usize;
                if index >= texts.len() || vectors[index].is_some() {
                    return Err(AiError::new("bad-response", "Invalid embedding index"));
                }
                vectors[index] = Some(parsed);
            }
            if vectors.iter().any(|v| v.is_none()) {
                return Err(AiError::new("bad-response", "Missing embedding vector"));
            }
            Ok(vectors.into_iter().map(|v| v.unwrap_or_default()).collect())
        };
        tokio::select! {
            _ = token.cancelled() => Err(AiError::new("timeout", "Request timed out")),
            _ = tokio::time::sleep(Duration::from_millis(EMBED_TIMEOUT_MS)) => Err(AiError::new("timeout", "Request timed out")),
            r = fut => r,
        }
    }

    /// 中止指定请求；请求不存在返回 false。
    pub(crate) fn abort(&self, request_id: &str) -> bool {
        self.tasks
            .lock()
            .expect("ai tasks 锁中毒")
            .get(request_id)
            .map(|t| t.cancel())
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_config::ClientConfig;

    fn cfg() -> ClientConfig {
        ClientConfig {
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            api_key: "sk-test".into(),
            temperature: 0.7,
            streaming: true,
            needs_key: true,
            embed_model: String::new(),
        }
    }

    fn collect(parser: &mut SseParser, chunks: &[&str]) -> Vec<SseItem> {
        let mut items = Vec::new();
        for c in chunks {
            parser.push(c, &mut |item| items.push(item));
        }
        parser.flush(&mut |item| items.push(item));
        items
    }

    #[test]
    fn sanitize_messages_enforces_roles_and_limits() {
        let ok = serde_json::json!([
            { "role": "user", "content": "你好" },
            { "role": "assistant", "content": "你好！" }
        ]);
        assert_eq!(sanitize_messages(&ok).unwrap().len(), 2);
        // 非法角色
        let bad_role = serde_json::json!([{ "role": "tool", "content": "x" }]);
        assert_eq!(sanitize_messages(&bad_role).unwrap_err(), "invalid role");
        // 空列表
        assert_eq!(
            sanitize_messages(&serde_json::json!([])).unwrap_err(),
            "invalid messages"
        );
        // 超长
        let too_long =
            serde_json::json!([{ "role": "user", "content": "a".repeat(MAX_MESSAGE_CHARS + 1) }]);
        assert_eq!(
            sanitize_messages(&too_long).unwrap_err(),
            "message too large"
        );
        // 合计超限：多条各自低于单条上限，总和超过总量上限
        let too_many: Vec<Value> = (0..5)
            .map(|_| serde_json::json!({ "role": "user", "content": "b".repeat(90_000) }))
            .collect();
        assert_eq!(
            sanitize_messages(&Value::Array(too_many)).unwrap_err(),
            "request too large"
        );
    }

    #[test]
    fn sanitize_texts_enforces_limits() {
        let ok = serde_json::json!(["a", "b"]);
        assert_eq!(sanitize_texts(&ok).unwrap().len(), 2);
        assert_eq!(
            sanitize_texts(&serde_json::json!([])).unwrap_err(),
            "invalid texts"
        );
        let too_long = serde_json::json!(["c".repeat(MAX_EMBED_TEXT_CHARS + 1)]);
        assert_eq!(sanitize_texts(&too_long).unwrap_err(), "text too large");
    }

    #[test]
    fn sse_parser_tolerates_arbitrary_chunk_boundaries() {
        let mut p = SseParser::new();
        // 一行 JSON 被拆到三个 chunk
        let items = collect(&mut p, &["data: {\"a\"", ":1}\ndat", "a: [DONE]\n"]);
        assert_eq!(items.len(), 2);
        assert!(matches!(items[0], SseItem::Data(_)));
        assert!(matches!(items[1], SseItem::Done));
    }

    #[test]
    fn sse_parser_handles_crlf_keepalive_and_trailing_flush() {
        let mut p = SseParser::new();
        let items = collect(
            &mut p,
            &[": keepalive\r\ndata: {\"x\":true}\r\n\r\ndata: {\"y\":2}"],
        );
        assert_eq!(items.len(), 2);
        assert!(matches!(items[0], SseItem::Data(_)));
        // 保活注释行被忽略；末行无换行由 flush 补上
        assert!(matches!(items[1], SseItem::Data(_)));
    }

    #[test]
    fn code_for_status_mapping() {
        assert_eq!(code_for_status(401), "unauthorized");
        assert_eq!(code_for_status(404), "not-found");
        assert_eq!(code_for_status(429), "rate-limited");
        assert_eq!(code_for_status(500), "server-error");
        assert_eq!(code_for_status(400), "bad-request");
    }

    #[test]
    fn read_error_message_extracts_upstream_text() {
        assert_eq!(
            read_error_message(r#"{"error":{"message":"Invalid key"}}"#),
            "Invalid key"
        );
        assert_eq!(read_error_message(r#"{"message":"直接字段"}"#), "直接字段");
        assert_eq!(read_error_message("plain text"), "plain text");
        assert_eq!(read_error_message(""), "");
    }

    #[test]
    fn endpoint_builds_url_and_auth_header() {
        let (url, headers) = AiClientState::endpoint(&cfg(), "chat/completions");
        assert_eq!(url, "https://api.deepseek.com/v1/chat/completions");
        assert!(headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer sk-test"));
        // 尾部斜杠被规整
        let mut c = cfg();
        c.base_url = "https://x.com/v1///".into();
        c.api_key = String::new();
        let (url, headers) = AiClientState::endpoint(&c, "embeddings");
        assert_eq!(url, "https://x.com/v1/embeddings");
        assert!(!headers.iter().any(|(k, _)| k == "Authorization"));
    }

    #[test]
    fn abort_returns_false_for_unknown_request() {
        let state = AiClientState::new();
        assert!(!state.abort("nope"));
    }
}
