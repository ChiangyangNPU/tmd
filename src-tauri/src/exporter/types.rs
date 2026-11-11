//! 导出链的渲染层契约类型：与 export-bridge.ts / native.ts 逐字段对齐。
//! 拆自 exporter.rs（2026-11-12）；camelCase 由 serde 映射。

/// exportRun 入参（camelCase 由 serde 映射；task 对壳不透明，透传离屏页）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportRunOptions {
    pub task: serde_json::Value,
    pub default_name: String,
    pub filters: Vec<ExportFilter>,
}

/// 保存框文件类型过滤器
#[derive(serde::Deserialize)]
pub(crate) struct ExportFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// 截图原语入参（CSS px；zoom 为 CSS px → DIP 换算系数，见 export-bridge.ts）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRequest {
    pub width_css: Option<f64>,
    pub height_css: Option<f64>,
    pub region: Option<CaptureRegion>,
    pub zoom: f64,
    pub scroll_y_css: Option<f64>,
}

/// 视口内矩形区域（CSS px，相对视口左上角）
#[derive(serde::Deserialize)]
pub(crate) struct CaptureRegion {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// 截图原语结果（export-bridge.ts CaptureResult）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureResult {
    pub(crate) data_url: String,
    pub(crate) physical_width: u32,
    pub(crate) physical_height: u32,
    pub(crate) pixel_ratio: f64,
}

/// 离屏页结果回传（字节 base64；见 EXPORTER_API_SHIM 说明）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DonePayload {
    pub(crate) ok: bool,
    pub(crate) bytes_b64: Option<String>,
    pub(crate) error: Option<String>,
}
