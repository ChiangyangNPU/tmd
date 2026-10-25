# TMD Tauri Spike 技术验证

> 分支：`spike/tauri`　创建：2026-10-25　对应评估：[Tauri迁移评估.md](Tauri迁移评估.md)
> 本分支的使命是**回答 go/no-go**，不是功能迁移。全部代码可随分支废弃。

## 这个分支验证什么

| # | 验证项 | 对应评估里的风险 | 判定标准 |
|---|--------|------------------|----------|
| 1 | WKWebView 原样加载渲染层 | §5 IME 风险的前提：内核换了，应用还跑不跑 | 编辑器 / Mermaid / KaTeX 启动即渲染，控制台无致命错误 |
| 2 | **ProseMirror 中文 IME**（go/no-go 级） | §5 一等风险 | 中文输入法组合输入全程：光标不跳、不丢字、候选框位置正确；与 Electron 版对比无感差异 |
| 3 | `window.tmdAPI` 契约可由 Tauri 实现 | 评估 §3.2 全部自写命令的派发模式 | `native.ts` 零改动，三条真实通道（readFile / saveFile / readDir）功能与 Electron 版一致 |
| 4 | 编码读写 Rust 化原型 | §3.2「编码读写」（JS 做不到编码端） | UTF-8(BOM) / UTF-16LE/BE / GBK 打开后按原编码写回，CRLF 保持 |

评估文档的另外两个验证项（PDF / 截图原型、PicGo 方案）依赖平台 shim 调研，列入后续，见 [§4](#4-后续验证项未开工)。

## 怎么跑

```bash
npm run tauri dev     # 自动起 vite(5173) + cargo 构建 + 打开 WKWebView 窗口
```

- 首次运行 cargo 拉全量依赖（rsproxy 不可用时官方 crates.io 实测直连畅通），之后增量构建秒级。
- 窗口加载的是 vite 开发服务器（`build.devUrl`）；`npm run tauri build` 则加载 `dist/` 生产产物。
- identifier 用 `com.chiangyang.tmd.spike`：userData 与已安装的 Electron 版**完全隔离**，随便折腾。
- 系统标题栏保留（spike 不做自绘标题栏适配，那是迁移期的确定性工程）。

## 已实现（spike 范围）

> spike 四项验证已全部通过（2026-10-25），已合入 master 转入正式迁移；本节与
> 下节保留作为验证记录与后续验证清单。

- `src-tauri/src/main.rs`：窗口创建 + `initialization_script` 注入 `window.tmdAPI` Proxy 门面
- 已实现通道（9 条，与 `native.ts` 契约逐字段对齐，含 `isNative: true`）：
  `readFile` / `saveFile` / `readDir` / `openFile` / `openFolder` / `saveFileAs` /
  `exportAs`（对话框四件套走 tauri-plugin-dialog 的 Rust 侧 API，无需 capabilities 放行）、
  `searchFiles` / `wikiScan`
- 纯逻辑模块化（与 electron/ 模块边界一一对应，JS 版保留服务 Electron 壳，改动需两处同步）：
  - `text_file.rs` ← `electron/text-file.cjs`（encoding_rs：BOM/UTF-16/GBK + CRLF）
  - `search.rs` ← `electron/search.cjs`（BFS 收集 / 跳过目录 / 扩展名白名单 /
    2MB·5000 文件·500 命中三重上限 / occurrence 定位协议；匹配在字符空间，
    中文行的 column 与 JS 的 UTF-16 口径一致）
  - `wikilinks.rs` ← `electron/wikilinks.cjs`（围栏跳过 / 三档解析 / ambiguous）
- 未实现通道：no-op + console.warn（不阻塞启动；渲染层的 `!native` 降级判断不受影响）
- Rust 单测 9 例（收集过滤 / 上限截断 / column+occurrence / 二进制跳过 / 预览截断 /
  inner 解析 / 围栏边界 / 三档解析含 ambiguous / e2e 形状）
- 窗口由 Rust 侧 `WebviewWindowBuilder` 创建（而非 tauri.conf.json）——因为 initialization_script
  只能走 builder，这也是正式迁移的必经形态。

## 后续验证项（未开工）

1. **PDF 导出**：WebView2 `PrintToPdfAsync`（Windows）原型；macOS WKWebView 无 API，验证「系统打印对话框存储为 PDF」降级路径的体验
2. **长图/Word/ePub 截图原语**：WKWebView `takeSnapshotWithConfiguration` / WebView2 `CapturePreview`
   隐藏窗口原型，跑通 `src/export-bridge.ts` 的 CaptureRequest 协议；重点验证隐藏窗口渲染节流
3. **PicGo 方案**：Rust 重写范围圈定（7 家图床取舍）或 sidecar 或产品降级
4. **E2E 驱动**：CDP 不可用后的回归方案（tauri-driver / 单测下沉 / 人工清单）

## 判定与去向

- 验证 1–4 通过 → 按评估 §6 顺序在 master 双壳共存迁移（不拉长分支，理由见评估与迁移讨论）
- 验证 2（IME）失败且无 workaround → 停止迁移，Tauri 评估结论作废，Electron 路线继续
- 验证 1/3/4 有缺口但验证 2 通过 → 评估工作量重估后再决策
