//! 命令错误类型：所有 `#[tauri::command]` 统一返回 `Result<T, CmdError>`。
//!
//! 为什么是「大写 code + 中文 message」：
//! - `code` 是机器可判别的稳定标识（`io` / `not_found` / `permission` /
//!   `invalid` / `cancelled` / `auth` / `network` / `internal`），供渲染层做
//!   分支处理（提示、重试、引导配置），**不随文案调整而变化**；
//! - `message` 是直接给用户看的中文文案，沿用迁移前各命令的原文，避免
//!   「改错误结构」顺带改掉用户已熟悉的提示；
//! - 两者分离后，日志与上报可以只看 code 聚合，UI 只展示 message。
//!
//! 前端如何消费：shim（tmd-api-shim.js 的 `call`）把 reject 值统一转成
//! `Error` 实例并把 `code` 挂到 `err.code`，调用方沿用既有 `catch (e)` 后
//! 读取 `e.message` 展示即可；需要区分错误类别的调用方再判断 `e.code`。
//!
//! 新增命令时如何选 code：
//! - 文件/目录读写失败，或系统调用返回 `std::io::Error` → `io`
//! - 目标不存在（文件/目录/记录缺失） → `not_found`
//! - 路径或系统权限被拒 → `permission`
//! - 入参非法（路径穿越、格式错误、超出上限） → `invalid`
//! - 用户主动取消（对话框取消等） → `cancelled`
//! - 凭据缺失/无效（API Key、签名公钥） → `auth`
//! - 网络请求失败或超时 → `network`
//! - 其余（内部状态异常、任务超时、通道中断） → `internal`
//!
//! 判断不确定时保持 `internal`，不要为了分类而改变面向用户的文案。
//!
//! @author chiangyang

use serde::Serialize;

/// 命令边界错误：`{ code, message }` 直接作为 invoke 的 reject 值序列化。
#[derive(Debug, Serialize)]
pub(crate) struct CmdError {
    /// 机器可判别的大写分类（见模块注释的 code 清单）
    code: &'static str,
    /// 面向用户的中文文案（沿用原有命令文案）
    message: String,
}

/// 错误分类构造器是命令层的公共词汇表：个别分类当前尚无调用点
/// （not_found / permission / cancelled / auth / network），保留给后续命令直接取用。
#[allow(dead_code)]
impl CmdError {
    /// 通用构造：code 为自定义分类，message 为展示文案
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// 文件/目录/系统 IO 失败
    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }

    /// 目标不存在
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    /// 路径或系统权限被拒
    pub(crate) fn permission(message: impl Into<String>) -> Self {
        Self::new("permission", message)
    }

    /// 入参或格式非法
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }

    /// 用户主动取消
    pub(crate) fn cancelled(message: impl Into<String>) -> Self {
        Self::new("cancelled", message)
    }

    /// 凭据缺失或无效
    pub(crate) fn auth(message: impl Into<String>) -> Self {
        Self::new("auth", message)
    }

    /// 网络请求失败
    pub(crate) fn network(message: impl Into<String>) -> Self {
        Self::new("network", message)
    }

    /// 内部异常（兜底分类）
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CmdError {}

/// 系统 IO 错误按 `io` 归类，文案沿用 Error 的 Display
impl From<std::io::Error> for CmdError {
    fn from(err: std::io::Error) -> Self {
        Self::io(err.to_string())
    }
}

/// 兼容现存「内部辅助函数返回 String」的写法：`?` 自动转成 `internal`
impl From<String> for CmdError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

/// 同上，兼容 `Err(String)` 式的字符串字面量
impl From<&str> for CmdError {
    fn from(message: &str) -> Self {
        Self::internal(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let err = CmdError::invalid("saveImage: 非法入参");
        let value = serde_json::to_value(&err).expect("CmdError 应可序列化");
        assert_eq!(value["code"], "invalid");
        assert_eq!(value["message"], "saveImage: 非法入参");
    }
}
