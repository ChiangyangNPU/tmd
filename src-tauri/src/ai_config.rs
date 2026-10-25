//! AI 配置持久化（electron/ai-config.cjs 的 Rust 移植）。
//!
//! 与 JS 版逐项对齐：服务商预设（全部走 OpenAI 兼容协议）/ 配置字段白名单
//! 归一化（文件损坏/旧版本/恶意入参统一走 sanitize）/ 增量合并语义
//! （patch 缺省字段保持原值、context 嵌套单独合并、切换服务商回落预设
//! baseUrl/model）/ apiKey 仅非空串更新、clearApiKey 清除、其余保留。
//! 渲染层永远拿不到明文 Key（publicView 只给 hasApiKey / apiKeyLength）。
//!
//! Key 存储与 JS 版的差异：Electron 用 safeStorage 加密成 `secret.enc`
//! 塞在配置文件里；Tauri 侧用系统钥匙串（keyring crate），配置文件只落
//! `secret.keychain: true` 标记。降级路径同 JS：钥匙串不可用时明文落
//! `secret.plain`（用户私有目录权限）。两者 userData 目录互不相通，无兼容需求。
//!
//! @author chiangyang

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// 内置服务商预设：全部走 OpenAI 兼容协议，一套请求实现。
/// needsKey：云端必须填 Key；Ollama 与自定义本地端点允许留空。
pub(crate) const AI_PROVIDERS: &[(&str, &str, &str, &str, bool)] = &[
    // (id, label, baseUrl, model, needsKey)
    (
        "openai",
        "OpenAI",
        "https://api.openai.com/v1",
        "gpt-4o-mini",
        true,
    ),
    (
        "deepseek",
        "DeepSeek",
        "https://api.deepseek.com/v1",
        "deepseek-chat",
        true,
    ),
    (
        "moonshot",
        "Moonshot (Kimi)",
        "https://api.moonshot.cn/v1",
        "moonshot-v1-8k",
        true,
    ),
    (
        "zhipu",
        "智谱 GLM",
        "https://open.bigmodel.cn/api/paas/v4",
        "glm-4-flash",
        true,
    ),
    (
        "ollama",
        "Ollama（本地）",
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        false,
    ),
    ("custom", "自定义（OpenAI 兼容）", "", "", false),
];

const DEFAULT_PROVIDER: &str = "deepseek";
#[cfg_attr(test, allow(dead_code))] // 测试构建隔离钥匙串，常量仅非测试路径使用
const KEYCHAIN_SERVICE: &str = "tmd-ai-key";

fn preset_of(provider: &str) -> Option<&(&str, &str, &str, &str, bool)> {
    AI_PROVIDERS.iter().find(|p| p.0 == provider)
}

/// 归一化后的设置（不含 Key）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettings {
    pub enabled: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub streaming: bool,
    pub context: AiContextScope,
    pub embed_model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiContextScope {
    pub selection: bool,
    pub document: bool,
    pub workspace: bool,
}

impl Default for AiContextScope {
    fn default() -> Self {
        // 默认只发用户显式选中的内容
        AiContextScope {
            selection: true,
            document: false,
            workspace: false,
        }
    }
}

/// 把任意入参钳制为 0–2 的数字（保留 1 位小数）
pub(crate) fn clamp_temperature(v: &Value, fallback: f64) -> f64 {
    let Some(n) = v.as_f64() else { return fallback };
    if !n.is_finite() {
        return fallback;
    }
    (n.clamp(0.0, 2.0) * 10.0).round() / 10.0
}

/// 校验并归一化 baseUrl：只接受 http/https 且无空白；尾部斜杠去掉。
/// 非法时回落服务商预设（custom 允许空串）。
pub(crate) fn normalize_base_url(value: &Value, provider: &str) -> String {
    let trim_tail = |raw: &str| raw.trim().trim_end_matches('/').to_string();
    if let Some(raw) = value.as_str() {
        if !raw.trim().is_empty() {
            let trimmed = trim_tail(raw);
            if !trimmed.contains(char::is_whitespace) {
                if let Ok(parsed) = url::Url::parse(&trimmed) {
                    if matches!(parsed.scheme(), "http" | "https") {
                        return trimmed;
                    }
                }
            }
        }
    }
    preset_of(provider)
        .map(|p| p.2.to_string())
        .unwrap_or_default()
}

/// 按白名单归一化配置字段。
pub(crate) fn sanitize_settings(raw: &Value) -> AiSettings {
    let provider = raw
        .get("provider")
        .and_then(Value::as_str)
        .filter(|p| preset_of(p).is_some())
        .unwrap_or(DEFAULT_PROVIDER);
    let preset_model = preset_of(provider)
        .map(|p| p.3.to_string())
        .unwrap_or_default();
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut s = s;
            s.truncate(120);
            s
        })
        .unwrap_or(preset_model);
    let context = raw.get("context");
    AiSettings {
        enabled: raw.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        provider: provider.to_string(),
        base_url: normalize_base_url(raw.get("baseUrl").unwrap_or(&Value::Null), provider),
        model,
        temperature: clamp_temperature(raw.get("temperature").unwrap_or(&Value::Null), 0.7),
        // streaming !== false → 默认 true
        streaming: raw
            .get("streaming")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        context: AiContextScope {
            selection: context
                .and_then(|c| c.get("selection"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
            document: context
                .and_then(|c| c.get("document"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            workspace: context
                .and_then(|c| c.get("workspace"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        embed_model: raw
            .get("embedModel")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect(),
    }
}

// ---------- Key 的钥匙串存取 ----------

/// 钥匙串条目；测试构建下返回 None（单测绝不触碰系统钥匙串，走明文降级路径）。
fn keychain_entry() -> Option<keyring::Entry> {
    #[cfg(test)]
    {
        return None;
    }
    #[cfg(not(test))]
    keyring::Entry::new(KEYCHAIN_SERVICE, "ai-api-key").ok()
}

fn encrypt_secret(plain: &str) -> Value {
    if let Some(entry) = keychain_entry() {
        if entry.set_password(plain).is_ok() {
            return serde_json::json!({ "v": 1, "keychain": true });
        }
    }
    // 钥匙串不可用：降级明文（用户私有目录权限），与 JS 版降级哲学一致
    serde_json::json!({ "v": 1, "plain": plain })
}

/// 解密 Key：钥匙串读不出（换机器/条目被清）返回空串，用户需重新填写
fn decrypt_secret(secret: &Value) -> String {
    if secret
        .get("keychain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return keychain_entry()
            .and_then(|e| e.get_password().ok())
            .unwrap_or_default();
    }
    secret
        .get("plain")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// AI 配置服务（管理配置文件路径 + 内存中的钥匙串句柄）
pub(crate) struct AiConfigState {
    config_file: PathBuf,
}

impl AiConfigState {
    /// 创建配置服务（config_file 为 userData 下的 ai-config.json 路径）
    pub fn new(config_file: PathBuf) -> Self {
        AiConfigState { config_file }
    }

    /// 读取磁盘原始记录；文件缺失 / JSON 损坏时返回空对象
    fn read_raw(&self) -> Value {
        fs::read_to_string(&self.config_file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// 读取完整配置（含明文 Key，仅供壳内使用，绝不返回渲染层）
    pub fn read(&self) -> (AiSettings, String) {
        let raw = self.read_raw();
        let key = decrypt_secret(raw.get("secret").unwrap_or(&Value::Null));
        (sanitize_settings(&raw), key)
    }

    /// 渲染层可见视图：剔除明文 Key + 下发服务商预设表
    pub fn public_view(&self) -> Value {
        let (settings, key) = self.read();
        let mut view = serde_json::to_value(&settings).expect("AiSettings 序列化失败");
        view["hasApiKey"] = Value::Bool(!key.is_empty());
        view["apiKeyLength"] = Value::from(key.chars().count());
        view["providers"] = Value::Array(
            AI_PROVIDERS
                .iter()
                .map(|(id, label, base_url, model, needs_key)| {
                    serde_json::json!({
                        "id": id,
                        "label": label,
                        "baseUrl": base_url,
                        "model": model,
                        "needsKey": needs_key,
                    })
                })
                .collect(),
        );
        view
    }

    /// 保存配置（增量合并语义见模块头注释），返回最新视图。
    pub fn save(&self, patch: &Value) -> Value {
        let raw = self.read_raw();
        let current = sanitize_settings(&raw);
        let next_provider: String = patch
            .get("provider")
            .and_then(Value::as_str)
            .filter(|p| preset_of(p).is_some())
            .unwrap_or(&current.provider)
            .to_string();

        // 合并：current ← patch；context 嵌套单独合并（只传一个布尔不能抹掉另一个）
        let mut input = serde_json::to_value(&current).expect("AiSettings 序列化失败");
        if let Some(obj) = input.as_object_mut() {
            if let Some(patch_obj) = patch.as_object() {
                // context 不走平铺拷贝：它会在下面以 obj 现值为基底做嵌套合并
                for (k, v) in patch_obj {
                    if k == "context" {
                        continue;
                    }
                    obj.insert(k.clone(), v.clone());
                }
            }
            let base_ctx = obj.get("context").cloned().unwrap_or_else(|| {
                serde_json::to_value(&current.context).expect("context 序列化失败")
            });
            let merged_ctx = match patch.get("context") {
                Some(patch_ctx) if patch_ctx.is_object() => {
                    let mut merged = base_ctx;
                    if let (Some(m), Some(p)) = (merged.as_object_mut(), patch_ctx.as_object()) {
                        for (k, v) in p {
                            m.insert(k.clone(), v.clone());
                        }
                    }
                    merged
                }
                _ => base_ctx,
            };
            obj.insert("context".into(), merged_ctx);
        }
        // 只切换服务商而没显式带地址/模型时，回落新服务商预设
        if next_provider != current.provider {
            if patch.get("baseUrl").and_then(Value::as_str).is_none() {
                input["baseUrl"] = Value::String(
                    preset_of(&next_provider)
                        .map(|p| p.2.into())
                        .unwrap_or_default(),
                );
            }
            if patch.get("model").and_then(Value::as_str).is_none() {
                input["model"] = Value::String(
                    preset_of(&next_provider)
                        .map(|p| p.3.into())
                        .unwrap_or_default(),
                );
            }
        }
        let merged = sanitize_settings(&input);
        let mut next = serde_json::to_value(&merged).expect("AiSettings 序列化失败");
        next["version"] = Value::from(1);

        let raw_key = patch
            .get("apiKey")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !raw_key.is_empty() {
            next["secret"] = encrypt_secret(&raw_key);
        } else if patch
            .get("clearApiKey")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(obj) = next.as_object_mut() {
                obj.remove("secret");
            }
        } else if let Some(secret) = raw.get("secret") {
            next["secret"] = secret.clone();
        }

        // 同步原子写（临时文件 + rename）：避免退出路径丢最后一次保存
        let tmp = self.config_file.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(&next) {
            if let Some(parent) = self.config_file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::write(&tmp, json)
                .and_then(|_| fs::rename(&tmp, &self.config_file))
                .is_err()
            {
                let _ = fs::remove_file(&tmp);
            }
        }
        self.public_view()
    }

    /// 组装一次请求所需的连接参数（含 Key），overrides 仅取非空字段。
    pub fn get_client_config(&self, overrides: &Value) -> ClientConfig {
        let (base, key) = self.read();
        let merged_provider: String = overrides
            .get("provider")
            .and_then(Value::as_str)
            .filter(|p| preset_of(p).is_some())
            .unwrap_or(&base.provider)
            .to_string();
        let preset_needs_key = preset_of(&merged_provider).map(|p| p.4).unwrap_or(false);
        let same_provider = merged_provider == base.provider;
        let base_url = match overrides.get("baseUrl").and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => {
                normalize_base_url(&Value::String(s.to_string()), &merged_provider)
            }
            _ if same_provider => base.base_url.clone(),
            _ => normalize_base_url(&Value::Null, &merged_provider),
        };
        let model = match overrides.get("model").and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => s.trim().chars().take(120).collect(),
            _ if same_provider => base.model.clone(),
            _ => preset_of(&merged_provider)
                .map(|p| p.3.into())
                .unwrap_or_default(),
        };
        let api_key = match overrides.get("apiKey").and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => key,
        };
        let temperature = match overrides.get("temperature") {
            Some(v) if !v.is_null() => clamp_temperature(v, base.temperature),
            _ => base.temperature,
        };
        let streaming = match overrides.get("streaming") {
            Some(Value::Bool(false)) => false,
            _ => base.streaming,
        };
        ClientConfig {
            provider: merged_provider,
            base_url,
            model,
            api_key,
            temperature,
            streaming,
            needs_key: preset_needs_key,
            embed_model: match overrides.get("embedModel").and_then(Value::as_str) {
                Some(s) if !s.trim().is_empty() => s.trim().chars().take(120).collect(),
                _ => base.embed_model.clone(),
            },
        }
    }
}

/// 一次请求所需的连接参数（ai_client 用）
#[derive(Clone, Debug)]
pub(crate) struct ClientConfig {
    /// 服务商标识（请求体不含此字段；保留以对齐 JS ChatConfig 契约并供日志排查）
    #[allow(dead_code)]
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f64,
    pub streaming: bool,
    pub needs_key: bool,
    pub embed_model: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_temperature_rounds_and_bounds() {
        assert_eq!(clamp_temperature(&Value::from(1.234), 0.7), 1.2);
        assert_eq!(clamp_temperature(&Value::from(9.0), 0.7), 2.0);
        assert_eq!(clamp_temperature(&Value::from(-1.0), 0.7), 0.0);
        assert_eq!(clamp_temperature(&Value::Null, 0.7), 0.7);
        assert_eq!(clamp_temperature(&Value::from("abc"), 0.7), 0.7);
    }

    #[test]
    fn normalize_base_url_falls_back_to_preset() {
        assert_eq!(
            normalize_base_url(&Value::from("https://x.example.com/api/"), "deepseek"),
            "https://x.example.com/api"
        );
        // 非法 → 预设
        assert_eq!(
            normalize_base_url(&Value::from("not a url"), "deepseek"),
            "https://api.deepseek.com/v1"
        );
        // http 以外的协议拒绝
        assert_eq!(
            normalize_base_url(&Value::from("ftp://x.com"), "openai"),
            "https://api.openai.com/v1"
        );
        // 未知服务商 → 空串
        assert_eq!(normalize_base_url(&Value::Null, "ghost"), "");
    }

    #[test]
    fn sanitize_settings_whitelists_fields() {
        let raw = serde_json::json!({
            "enabled": "yes", // 非 bool → false
            "provider": "evil-provider", // 不在白名单 → 默认 deepseek
            "model": "  m1  ",
            "temperature": "bad",
            "streaming": false,
            "context": { "document": true, "selection": false, "workspace": 1 },
            "baseUrl": "https://ok.example.com/",
        });
        let s = sanitize_settings(&raw);
        assert!(!s.enabled);
        assert_eq!(s.provider, "deepseek");
        assert_eq!(s.model, "m1");
        assert_eq!(s.temperature, 0.7);
        assert!(!s.streaming);
        assert_eq!(s.base_url, "https://ok.example.com");
        assert!(!s.context.selection);
        assert!(s.context.document);
        // workspace: 1 不是 true → false
        assert!(!s.context.workspace);
        assert_eq!(s.embed_model, "");
    }

    #[test]
    fn save_merges_patch_without_wiping_context() {
        let root = std::env::temp_dir().join(format!("tmd-ai-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let file = root.join("ai-config.json");
        let state = AiConfigState::new(file.clone());
        // 初次保存：provider + document
        state.save(&serde_json::json!({
            "provider": "openai",
            "context": { "document": true }
        }));
        let (s, _) = state.read();
        assert_eq!(s.provider, "openai");
        // 只传一个布尔不能抹掉另一个
        assert!(s.context.selection, "缺省 selection 应保持默认 true");
        assert!(s.context.document);
        // 切换服务商未带地址/模型 → 回落新预设
        state.save(&serde_json::json!({ "provider": "ollama" }));
        let (s, _) = state.read();
        assert_eq!(s.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(s.model, "qwen2.5:7b");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn key_roundtrip_via_public_view() {
        let root = std::env::temp_dir().join(format!("tmd-ai-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let state = AiConfigState::new(root.join("ai-config.json"));
        let view = state.save(&serde_json::json!({ "apiKey": "  sk-test-123  " }));
        assert_eq!(view["hasApiKey"], Value::Bool(true));
        // keychain 失败时降级明文，两种路径长度一致（trim 后 11 字符）
        assert_eq!(view["apiKeyLength"], Value::from(11));
        assert!(view.get("apiKey").is_none(), "明文 Key 绝不外传");
        // clearApiKey 清除
        let view = state.save(&serde_json::json!({ "clearApiKey": true }));
        assert_eq!(view["hasApiKey"], Value::Bool(false));
        // 两者都不传 → 保留原 Key（空串 ≠ 未修改）
        state.save(&serde_json::json!({ "apiKey": "sk-keep" }));
        state.save(&serde_json::json!({ "model": "m2" }));
        let view = state.public_view();
        assert_eq!(view["hasApiKey"], Value::Bool(true));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn client_config_overrides_merge() {
        let root = std::env::temp_dir().join(format!("tmd-ai-cc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let state = AiConfigState::new(root.join("ai-config.json"));
        state.save(&serde_json::json!({ "provider": "deepseek", "apiKey": "sk-base" }));
        let cfg = state.get_client_config(&serde_json::json!({}));
        assert_eq!(cfg.base_url, "https://api.deepseek.com/v1");
        assert!(cfg.needs_key);
        // overrides 非空字段生效
        let cfg = state.get_client_config(&serde_json::json!({
            "provider": "openai", "model": " gpt-x ", "temperature": 5
        }));
        assert_eq!(cfg.base_url, "https://api.openai.com/v1"); // 切服务商回落预设
        assert_eq!(cfg.model, "gpt-x");
        assert_eq!(cfg.temperature, 2.0);
        assert_eq!(cfg.api_key, "sk-base"); // 未带 key → 沿用
        let _ = fs::remove_dir_all(root);
    }
}
