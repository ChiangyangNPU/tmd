//! 离屏导出服务（Word / 长图 / ePub）——Tauri 壳正式实现。
//!
//! 薄壳分工（对齐 electron/exporter.cjs）：本目录只管导出窗口生命周期与
//! 平台原语（尺寸设置 + 截帧 + 图片白名单读盘 + 保存框落盘），真正的编排
//! （Markdown 注入、Mermaid/KaTeX 渲染、分段、拼接、OOXML 转换）全部留在
//! 离屏页 src/export-renderer.ts，与 Electron 完全共用同一套 TS。
//!
//! 子模块：types（契约类型）/ util（纯函数）/ bridge（离屏页 exporterAPI
//! 注入脚本）/ worker（专职 worker + 探边窗口生命周期 + 任务执行）/
//! commands（四条 tauri 命令）/ pdf（print 通道）/ verify（端到端管线验证）。
//!
//! 与 Electron 的差异点（形态矩阵结论，见 docs/spike-tauri.md）：
//! - **窗口形态**：Electron 隐藏 + backgroundThrottling:false；WKWebView
//!   隐藏窗 rAF 冻结（页面编排会挂死）→ 屏边探出窗口，任务结束即销毁
//! - **字节回传**：离屏页 shim 统一 base64（4/3）回传，本模块解码后经
//!   worker 通道交落盘方
//! - **序列化**：专职 worker 线程 + mpsc 队列，同一时刻只跑一个任务
//!
//! @author chiangyang

pub(crate) mod commands;
pub(crate) mod pdf;
pub(crate) mod verify;

mod bridge;
mod types;
mod util;
mod worker;

pub(crate) use worker::init;

/// 单张本地图片读取上限（32MB，超限跳过而非撑爆导出内存）
pub(crate) use util::MAX_IMAGE_BYTES;

pub(crate) use util::image_mime_of;
