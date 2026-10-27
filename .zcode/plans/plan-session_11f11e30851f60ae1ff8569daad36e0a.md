## Windows 导出原语实现方案

### 已确认的架构事实（调研结论）

mac 侧把导出链分成了两层，Windows 只需补齐下面「原语层」，上层零改动：

- **编排层** `exporter.rs`（829 行）：窗口生命周期、任务队列、视口尺寸/滚动、保存框、落盘、桥接 shim —— **全部跨平台**，仅 4 个调用点碰平台原语：`eval_js`（5 处）、`capture_png`（1 处）、`capture_full_pdf`（1 处）、`read_content_metrics`（仅 mac 探针用）
- **原语层** `export_native.rs`（226 行，mac）：objc2 直调 WKWebView

API 已从依赖源码逐个核实（tauri 2.12.5 / webview2-com 0.39.1 / windows 0.62）：
| mac 原语 | Windows 等价物 | 备注 |
|---|---|---|
| `evaluateJavaScript` | `ICoreWebView2::ExecuteScript` | 结果是 JSON 编码，需解码还原 mac 语义 |
| `takeSnapshot`（rect=view 坐标） | `ICoreWebView2::CapturePreview` → 内存 IStream | **无 rect 参数**，区域模式先截全视口再裁剪 |
| `createPDF`（web page 矩形） | `ICoreWebView2_16::PrintToPdf`（直写文件） | **真正的分页打印管线**，比 mac 更接近 Electron（支持 @media print、页尺寸/边距/页眉页脚） |
| Tauri `with_webview` → `platform.inner()` | `platform.controller()` → `ICoreWebView2Controller` | 同款主线程闭包 + mpsc 回传模型 |

### 实施步骤

**1. 依赖（Cargo.toml，cfg(windows) 段）**
```toml
[target.'cfg(windows)'.dependencies]
webview2-com = "0.39"      # 与 wry 内部同版本，共享 ICoreWebView2 类型
windows = { version = "0.62", features = ["Win32_System_Com", "Win32_System_Com_StructuredStorage"] }
png = "0.18"               # 区域模式裁剪（已在依赖树中，不引入 image 大包）
```

**2. 模块切换（main.rs）** —— 调用点零改动：
```rust
#[cfg(target_os = "macos")]  mod export_native;                     // 现有文件
#[cfg(windows)] #[path = "export_native_win.rs"] mod export_native; // 新文件，同名模块
```
删除 `exporter_stub.rs` 与 main.rs 里的 stub 接线；`exporter` 在 Windows 恢复为完整实现。

**3. 新建 `export_native_win.rs`**（核心，约 500 行），对外与 mac 完全同签名：
- `with_core<T,F>(window, f)` —— `with_webview` 主线程闭包取 `controller.CoreWebView2()`，mpsc 回传，超时 10s
- `eval_js(window, script) -> Result<String,String>` —— ExecuteScript + 完成回调；结果 JSON 解码（`"ok"`→`ok`、`null`→空串），对齐 mac 语义
- `capture_png(window, rect: Option<(f64,f64,f64,f64)>) -> Result<Vec<u8>,String>` ——
  - `CreateStreamOnHGlobal` 建内存流 → `CapturePreview(PNG)` → 完成回调里 Seek(0) + Read 取全视口 PNG
  - `rect=Some` 时：按 `window.scale_factor()` 把 DIP 矩形换算成物理像素，`png` crate 解码→裁剪→重编码
  - 超时 30s
- `capture_viewport_png` / `read_content_metrics` —— 薄包装，与 mac 同签名
- `capture_full_pdf(window, w, h, options)` —— `ICoreWebView2Environment6::CreatePrintSettings` + `ICoreWebView2_16::PrintToPdf` 直写临时文件再读回；映射前端 PdfOptions：pageSize(A4/A3/A5/Letter/Legal)、orientation、margin(default/narrow/wide)、headerFooter/pageNumbers → `ShouldPrintHeaderAndFooter`、`ShouldPrintBackgrounds(true)`；大纲（bookmarks）WebView2 不支持，记入文档限制
- `verify_native(app)` —— spike 自动化验证入口（`TMD_SPIKE_EXPORT_OPS=1` 触发）：主窗口就绪后依次跑 视口截帧 / 区域截帧 / PDF，产物落 `std::env::temp_dir()`，并内联解码 PNG 统计非白像素比、PDF 校验 `%PDF-` 头，结果写日志 + stderr

**4. 小幅跨平台修正（exporter.rs / export_native.rs）**
- `verify_pipeline` 与 PDF 产物的 `/tmp/...` → `std::env::temp_dir()`（Windows 下 `/tmp` 不存在）
- `run_print` 把 `options` 传给 `capture_full_pdf`（mac 实现加 `_options` 参数并忽略，行为不变）
- 导出窗口 `.focused(true)` → mac 保持 true，Windows 用 `false`（不抢用户焦点；Windows 渲染不依赖焦点）
- `SETTLE`（180ms 沉降）：Windows 若实测截到旧帧，加 cfg 增到 300ms

**5. Windows 上编译与静态检查**
```bash
cargo clippy --bin tmd && cargo test --bin tmd   # 66 个已有单测必须保持全绿
```

**6. 运行时端到端验证（本机可全自动）**
```bash
# 长图链路（探边窗 + 视口截帧 + 分段滚动 + canvas 拼接 + base64 回传）
TMD_SPIKE_EXPORT_RUN=1 npm run tauri dev
# 原语直测（视口/区域/PDF 三件套 + 像素统计 + PDF 头校验）
TMD_SPIKE_EXPORT_OPS=1 npm run tauri dev
```
验收标准：长图产物为完整纵向拼接（非白、含标题红色 #b00020）、`pixelRatio ≈ zoom×dpr`、PDF 以 `%PDF-` 开头且页数 ≥1、区域裁剪尺寸与请求 rect 一致。

### 已知风险与预案（按发现顺序处置）

1. **截到空白帧**（最大风险）：WebView2 对不可见/被遮挡窗口会节流。mac 的「屏边探出 60px」策略大概率适用；若失败 → 依次尝试：加长沉降 → 临时全屏内可见（快速闪现）→ 改用 `IsVisible` 切换
2. **窗口超高**（单段 8000 物理 px）：Windows 上限约 32767px，余量充足；若 SetWindowPos 被钳制 → 缩小单段高度、增加段数（前端 planSegments 参数）
3. **CapturePreview 的 DPR 缩放**：按 `scale_factor()` 换算裁剪矩形并做边界钳制；pixelRatio 断言兜底
4. **PrintToPdf 首次调用慢**（建打印管线）：超时给 60s

### 范围边界

本次只做「原语层 + 跨平台接线 + 自动验证」。不含：PicGo、更新器、Windows NSIS 打包目标（各自独立事项）；mac 行为保持不变。
