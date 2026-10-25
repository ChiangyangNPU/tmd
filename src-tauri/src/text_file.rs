//! 文本文件编码读写（对应 electron/text-file.cjs 的 Rust 化，spike 起点）。
//!
//! 解码启发式：BOM 优先（UTF-8 / UTF-16LE/BE），无 BOM 时 UTF-8 合法则按
//! UTF-8，否则 GBK 兜底。写回按原编码与 BOM。encoding_rs 解码永不报错，
//! 以 had_errors 标记提示回退。
//!
//! 已知简化（对齐 text-file.cjs 留到正式迁移验收）：
//! - 无 BOM 的 UTF-16 启发式未实现（text-file.cjs 有）
//! - GBK 不可映射字符走数字字符引用（浏览器行为；iconv-lite 是替换字符）

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFileData {
    pub path: String,
    pub name: String,
    pub content: String,
    pub encoding: &'static str,
    pub bom: bool,
    pub line_ending: &'static str,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMeta {
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default)]
    pub bom: bool,
    /// 契约字段（native.ts TextFileMeta）：换行已含在 content 里，写回无需处理，
    /// 保留反序列化以锁住通道入参形状
    #[serde(default = "default_line_ending")]
    #[allow(dead_code)]
    pub line_ending: String,
}

fn default_encoding() -> String {
    "utf-8".into()
}

fn default_line_ending() -> String {
    "lf".into()
}

pub(crate) fn default_encoding_str() -> &'static str {
    "utf-8"
}

/// 解码（见模块头注释）。
pub(crate) fn decode(bytes: &[u8]) -> (&'static str, bool, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return ("utf-8", true, text.into_owned());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return ("utf-16le", true, text.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return ("utf-16be", true, text.into_owned());
    }
    let (text, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return ("utf-8", false, text.into_owned());
    }
    let (text, _, _) = encoding_rs::GBK.decode(bytes);
    ("gbk", false, text.into_owned())
}

/// 按原编码与 BOM 写回（GBK 不可映射字符的处理见模块头注释）。
pub(crate) fn encode(text: &str, encoding: &str, bom: bool) -> Vec<u8> {
    let (bytes, _, _) = match encoding {
        "gbk" => encoding_rs::GBK.encode(text),
        "utf-16le" => encoding_rs::UTF_16LE.encode(text),
        "utf-16be" => encoding_rs::UTF_16BE.encode(text),
        _ => encoding_rs::UTF_8.encode(text),
    };
    let mut out = Vec::with_capacity(bytes.len() + 3);
    match (bom, encoding) {
        (true, "utf-8") => out.extend_from_slice(&[0xEF, 0xBB, 0xBF]),
        (true, "utf-16le") => out.extend_from_slice(&[0xFF, 0xFE]),
        (true, "utf-16be") => out.extend_from_slice(&[0xFE, 0xFF]),
        _ => {}
    }
    out.extend_from_slice(&bytes);
    out
}

pub(crate) fn file_name_of(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 读取并解码文本文件 → TextFileData（含保存回写所需元信息）。
pub(crate) fn read_file_at(file_path: String) -> Result<TextFileData, String> {
    let bytes = fs::read(&file_path).map_err(|e| format!("{}: {}", file_path, e))?;
    if !Path::new(&file_path).is_file() {
        return Err(format!("not a regular file: {}", file_path));
    }
    let (encoding, bom, content) = decode(&bytes);
    let line_ending = if content.contains("\r\n") { "crlf" } else { "lf" };
    let name = file_name_of(&file_path);
    Ok(TextFileData {
        path: file_path,
        name,
        content,
        encoding,
        bom,
        line_ending,
    })
}
