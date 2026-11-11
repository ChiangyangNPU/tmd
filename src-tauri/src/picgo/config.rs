//! 配置读写：picBed 段的读取、整段保存，以及配置字段取值辅助。

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

use serde_json::{json, Value};
use std::path::Path;

/// 读 picBed 段。文件缺失/损坏/格式不符一律回落 `{ current: "" }`，
/// 让前端走「未配置」分支而不是抛错。
pub(crate) fn read_picbed(path: &Path) -> Value {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return json!({ "current": "" }),
    };
    let root: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return json!({ "current": "" }),
    };
    match root.get("picBed") {
        Some(picbed) if picbed.is_object() => picbed.clone(),
        _ => json!({ "current": "" }),
    }
}

/// 整段替换 picBed 并落盘；保留文件里的其他顶层键（PicGo 自身可能写入 uploader 等）
pub(crate) fn save_picbed(path: &Path, picbed: &Value) -> bool {
    let mut root = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    root["picBed"] = picbed.clone();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&root) {
        Ok(text) => std::fs::write(path, text).is_ok(),
        Err(_) => false,
    }
}

/// 取必填字符串字段；缺失或空串都视为未配置
pub(crate) fn need<'a>(cfg: &'a Value, key: &str) -> Result<&'a str, String> {
    match cfg.get(key).and_then(Value::as_str) {
        Some(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("图床配置缺少 {}", key)),
    }
}

pub(crate) fn field<'a>(cfg: &'a Value, key: &str) -> &'a str {
    cfg.get(key).and_then(Value::as_str).unwrap_or("")
}

/// 响应体截断：避免把整段 HTML 错误页写进日志
pub(crate) fn brief(body: &Value) -> String {
    let text = body.to_string();
    text.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::picgo::FILE_SEQ;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn config_roundtrip_keeps_other_keys() {
        let path = std::env::temp_dir().join(format!(
            "tmd-picgo-test-{}-{}.json",
            std::process::id(),
            FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, r#"{"picBed":{"current":"smms"},"other":1}"#).unwrap();
        assert!(save_picbed(
            &path,
            &json!({"current":"github","github":{"repo":"a/b"}})
        ));
        let picbed = read_picbed(&path);
        assert_eq!(picbed["current"], "github");
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["other"], 1, "picBed 之外的键必须保留");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_config_reads_empty_current() {
        let path = std::env::temp_dir().join("tmd-picgo-missing-never-exists.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_picbed(&path)["current"], "");
    }
}
