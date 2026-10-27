# TMD Electron → Tauri 迁移评估

> 版本：1.0　作者：chiangyang　更新：2026-10-24
> 本文档的作用：评估把 TMD 从 Electron 44 迁移到 Tauri 2 的可行性、工作量与风险，作为是否立项的决策依据。
> 结论先行：架构友好度高（渲染层零 Node 依赖、契约层现成），但存在**三个硬缺口**——PDF 导出、长图/Word/ePub 离屏导出、PicGo 图床。全功能对等迁移约 14–19 周（单人、含 Rust 学习曲线），降级方案约 7–10 周。建议先做 1–2 周技术验证 spike 再决定。
> 相关文档：[架构设计](架构设计.md)　[打包发布](打包发布.md)　[路线图](路线图.md)　[详细设计](详细设计.md)

## 1. 总体结论

| 维度 | 判断 |
|------|------|
| 架构适配度 | **高**。`src/native.ts:5` 注释明确「渲染层与壳层之间的唯一契约……保证壳层可替换（如未来迁移 Tauri）」，迁移主战场在 Rust 壳层重写，前端基本不动 |
| 收益 | 安装包 85MB dmg → 约 5–15MB；CI 大幅简化（trim-runtime / ULMO 重压缩 / blockmap / Gitee 配额清理整套消失）；macOS 更新绕开 Squirrel（现有 updater.cjs 560 行自研流程可删）；内存占用降低 |
| 最大风险 | 导出三件套依赖 `capturePage` + 离屏窗口，wry（Tauri 底层）**至今无截图 API**；PDF 依赖 `printToPDF`，**同样无 API**（已对照 wry 0.56.0 变更日志核实） |
| 决策点 | 导出（尤其长图/Word/ePub）是产品核心卖点还是可降级项？PicGo 生态兼容是否必须保留？——这两问决定走全量迁移还是放弃迁移 |

## 2. 现状盘点（迁移对象画像）

### 2.1 Electron 壳规模

- `electron/` 目录 27 个 `.cjs` 文件，约 6556 行；入口 `main.cjs`（557 行），另含 `preload.cjs`（主窗口）与 `exporter-preload.cjs`（离屏导出页，4 个方法最小权限）。
- 运行时依赖：`electron-updater`、`picgo`（Node-only，§4.3）、`iconv-lite`、`fflate`、`sanitize-html`、`d3-force`、`mathml2omml`。
- `webPreferences`：`contextIsolation: true, nodeIntegration: false, sandbox: false`（`main.cjs:377-384`；`sandbox:false` 仅因 preload 需 `require('./ipc.cjs')` 取通道常量，渲染层无 Node 权限）。

### 2.2 IPC 接口面

- **70 条通道**全部集中在 `electron/ipc.cjs:11-101` 一张常量表，用 `@type` + `tsc checkJs` 与 `src/native.ts` 做编译期对齐（缺键/多键/改类型编译期报错）。
- 主进程 59 个 handler（44 `handle` + 15 `on/once`），11 条主→渲染单向推送（menu / autosave / openPath / winMaxChanged / fileChanged / dirsChanged / aiStream / updateStatus / docSaveRequest / recentOpen / exporterTask）。
- `preload.cjs:191` 暴露唯一全局 `window.tmdAPI`（约 60 个方法）；`src/native.ts:440` `export const native = window.tmdAPI`，浏览器环境 undefined 各模块自行降级。
- 渲染层 28 个文件约 **46 处 `native.*` 调用**（高频：saveFile×6、readDir×6、readFile×5），**零 Node/Electron 直接引用**。
- 安全惯例：敏感通道经 `assertMainWindow` 做 sender 校验（`app-state.cjs:130-136`）；入参纵深防御成体系（路径穿越校验、50MB 读上限、外链协议白名单，`main.cjs:422-436`）。

### 2.3 导出管线（6 种格式、3 条机制路径）

| 格式 | 机制 | 可移植性 |
|------|------|----------|
| HTML / LaTeX | 渲染进程拼字符串/纯函数 → 主进程保存框落盘（`tmd:export-as`） | **完全可移植**（纯 JS） |
| PDF | **主窗口 `webContents.printToPDF`** 打印编辑器实时 DOM（`ipc-files.cjs:445-466`），版式靠 `@media print` / `@page` CSS（`src/styles/15-print.css`），页眉页脚/大纲用 Chromium 专有模板（`pdf-options.cjs`） | **难点**：无跨内核等价 API |
| Word / 长图 PNG / ePub | **离屏隐藏 BrowserWindow**（`exporter.cjs`，复用页 + 串行队列 + 3 分钟超时自愈）+ `capturePage` 分段截帧 + canvas 拼接；Word 走 dom-docx + OMML 公式注入（`mathml2omml` + `fflate`），ePub 走 XMLSerializer + fflate | **最大难点**：依赖截图原语 |

- 离屏导出页是 Vite 第二入口（`export-renderer.html` → `src/export-renderer.ts`），mermaid/KaTeX 走 vite 打包；`dist/export-assets`（`copy-export-assets.mjs` 拷贝）仅供离线 HTML/ePub 内联。
- 踩坑记录：`docs/archive/export-word-longimage_plan.md` 的「实施校准」节记了 4 个坑（Mermaid foreignObject 污染 canvas 导致当初弃用 html2canvas 类方案、zoom 归一、区域截帧双模式、公式保护）——**任何替代截图方案都必须重新验证这 4 项**。
- 有利条件：导出编排层已依赖注入化——`src/export-bridge.ts` 定义 `CaptureRequest/CaptureResult/ExporterBridge` 契约，`composeLongPng`/`rasterizeVisualBlocks` 接受注入实现，替换截图原语不动编排层。

### 2.4 打包 / 更新 / CI

- **打包**：electron-builder，mac dmg（arm64、ad-hoc 签名、自定义背景图）+ Windows NSIS（自绘目录页 `build/installer.nsh`，161 行）；`scripts/trim-runtime.cjs` afterPack 瘦身（裁语言包/GPU DLL/picgo CLI 依赖 mock）；`patch-mac-dmg.mjs` 把 dmg 转 ULMO 压缩以满足 Gitee 附件 100MB 上限。
- **更新**（`updater.cjs`，560 行）：electron-updater 双源——Gitee（`raw/master/releases/` generic provider，受 5 分钟 CDN 缓存）+ GitHub（error 时 failover 一次）；`autoDownload:false`；Windows 走标准下载安装；**macOS 完全自研**（Squirrel.Mac 在 macOS 26 + electron-updater 6.8.9 静默失败）：session.downloadURL + sha512 流式校验 + `xattr` 清 quarantine + openPath 挂载 dmg 后退出。脏文档「保存并重启」握手（`docSaveRequest/Result`，不设超时）。
- **CI**（`.github/workflows/release.yml`，334 行）：mac+win matrix 构建 → GitHub Release（gh CLI）→ Gitee（git 推 yml 到 master + API 上传附件 + 保留最近 2 版配额清理 + 上传后逐项核对）。`releases/latest*.yml` 是 Gitee 更新源权威副本。
- **本地状态**：`~/.tmd/`（themes / logs / crash-dumps / history 快照）；`userData/`（shell-state.json / picgo-config.json / ai-config.json 经 safeStorage 加密）；localStorage（文档恢复副本、最近文件权威、自定义 CSS）。
- **日志**（`logger.cjs`，419 行）：`~/.tmd/logs/app-YYYY-MM-DD.jsonl` 按天滚动，mtime 7 天 / 数量 10 个双策略清理，60 秒窗口去重计数，崩溃 minidump 扫描补记，零遥传。

## 3. 能力映射

### 3.1 官方插件直接对应（低风险）

| 现状 | Tauri 2 对应 |
|------|--------------|
| `requestSingleInstanceLock` + 二次启动 argv | `tauri-plugin-single-instance` |
| dialog / shell.openExternal / openPath | `plugin-dialog` / `plugin-opener` |
| 窗口几何持久化（shell-state.json） | `plugin-window-state`（悬空坐标校验、最大化还原几何需自补） |
| JSON 配置 | `plugin-store` 或 Rust serde |
| 文件关联 md/markdown | `bundle.fileAssociations`；macOS `open-file` 事件有对应 |
| 自绘标题栏 | Win/Linux `decorations:false` + drag region；macOS `hiddenInset` + 红绿灯定位需 `macOSPrivateApi:true` |
| `nativeTheme.themeSource` | `window.set_theme()` |
| 主题文件系统（`themes.cjs` 纯 Node 文件服务 + 前端 `<style>` 注入 + 防FOUC） | 基本原样：Rust 读 `~/.tmd/themes`，前端注入逻辑不动 |
| 菜单（文案由渲染层下发 + 自定义 accelerator 重建） | muda Menu 支持动态重建，模型吻合（role 的 i18n 需自管，但本项目本就是 IPC 下发文案，无增量成本） |
| CSP 注入（onHeadersReceived） | `tauri.conf.json` 静态 `security.csp`（按窗口区分可用 per-window config） |
| 拖拽路径（`webUtils.getPathForFile`） | Tauri drag-drop 事件原生带路径，更简单 |

### 3.2 需在 Rust 侧自写命令（中风险，做法明确）

| 能力 | 现状 | 要点 |
|------|------|------|
| 编码读写 | `iconv-lite`：BOM / 无 BOM UTF-16 启发式 / GBK 兜底解码，**按原编码+换行写回**（`text-file.cjs`） | 核心卖点「打开不改用户文件编码」。解码端浏览器 `TextDecoder('gbk')` 可用；**编码端（string→GBK/UTF-16BE 字节）JS 做不到**，必须 `encoding_rs` |
| 文件监听 | `fs.watch` 逐文件 + 200ms 防抖 + **sha1 内容指纹过滤自身写入回声**（noteWrite 基线）+ rename 后重建 watcher（`filewatcher.cjs`） | 要在 notify crate 之上重建三件套；**否则自动保存每 5 秒误报一次外部修改**。目录监听为非递归单层语义（`dirwatcher.cjs`） |
| 全文搜索 / 双链扫描 | 纯内存遍历：BFS、并发 8、跳 17 种依赖目录、5000 文件 / 2MB 单文件 / 500 命中上限（`search.cjs`、`wikilinks.cjs`） | Rust `walkdir` + 并发移植，上限语义是渲染层定位协议的一部分，不能丢；`wikilinks.cjs` 与 `src/wikilink.ts` 两侧同构，改动需同步 |
| 历史快照 | saveFile 写盘**前**全量快照到 `~/.tmd/history/<sha1前16>/`，sha1 去重、50 条/200MB 双层剪枝、失败静默（`history.cjs`） | 与保存是同一事务：应做成单个原子 Rust command（snapshot→write→指纹登记三步有序），拆散到前端编排会引入竞态 |
| AI 模块 | Node fetch + 手写 SSE 解析 + AbortController per-requestId；Key 经 safeStorage 加密落 `userData/ai-config.json`（`ai-client.cjs` / `ai-config.cjs`） | 镜像现有架构：Rust reqwest + event 复刻 `aiStream` 协议 + `keyring` crate 替代 safeStorage。**不建议**挪到前端 fetch（明文 Key 进渲染层 + CSP 需放开 connect-src） |
| 回收站删除 | `shell.trashItem` | `trash` crate 自定义命令 |
| 系统最近文档 | `app.addRecentDocument / clearRecentDocuments`（Jump List / Dock） | 无第一方 API，需平台代码（Win `SHAddToRecentDocs` / mac `NSDocumentController`）或放弃该层 |
| 日志 | JSONL 按天滚动 + 7 天/10 个清理 + 去重 | `plugin-log` 无按天策略，自写或简化 |

### 3.3 硬缺口（高风险，需产品决策）

> **落地状态（2026-10-27）**：缺口 1 / 缺口 2 的双平台原语均已实现并验收——
> mac 走 objc2 直调 WKWebView（`export_native.rs`），Windows 走 WebView2 COM
> （`export_native_win.rs`）；编排层 `exporter.rs` 零分叉。Windows 实测：
> 长图端到端产物 1848×597（完整纵向拼接、标题色正确），区域裁剪尺寸与
> `rect×dpr` 一致，PDF 为 1 页有效文档（WebView2 打印管线）。
> 下文保留决策期分析原文，供追溯。

#### 缺口 1：PDF 导出（`printToPDF` 无等价物）

已对照 wry 最新版（0.56.0）变更日志核实：**无 print_to_pdf API**，只有系统打印对话框（上游 issue [#707](https://github.com/tauri-apps/wry/issues/707) 未实现）。且 Chromium 专有的 `headerTemplate/footerTemplate`（pageNumber/totalPages）与 `generateDocumentOutline` 均无对应。

- Windows：WebView2 `PrintToPdfAsync`（ICoreWebView2_16）可自写对标，页眉页脚模板机制不同需降级设计。**已实现**：`PrintToPdf` 直写临时文件，走 Chromium 打印管线（@media print / @page 生效），PdfOptions 的页尺寸/朝向/边距/页眉页脚均已映射；仅大纲书签（outline）无对应项。
- **macOS：WKWebView 无 printToPDF**，无低成本等价物。现实选择：① 降级为系统打印对话框「存储为 PDF」（体验降级，用户多一步）；② 纯 JS PDF 生成库（渲染质量/分页与 Chromium 打印有差距）；③ 放弃 macOS PDF（不建议）。**已实现**：`createPDFWithConfiguration` 整页矩形直出（选项不生效，文档已标注）。

#### 缺口 2：长图 / Word / ePub（离屏窗口 + `capturePage` 无等价物）

wry 无截图 API（上游 issue [#1358](https://github.com/tauri-apps/wry/issues/1358)，截稿时有 PR 未落地）。三件套全部建立在「离屏隐藏窗口按帧渲染 + 分段 `capturePage` 截帧 + canvas 拼接」上。

- 方案 A（首选验证）：平台 shim——WebView2 `CapturePreview` / WKWebView `takeSnapshotWithConfiguration`。风险：隐藏窗口下渲染节流与截图可靠性未经验证（WebView2 隐藏窗口 CapturePreview 行为不可靠；`backgroundThrottling` 不可控，现有 `settle()` 双 rAF 等帧逻辑可能挂起）。**已实现并验证**：双平台均采用「屏边探出」窗口维持渲染（Windows 实测 `focused(false)` 不节流），CapturePreview 无 rect 参数→全视口截帧后按 dpr 裁剪补齐区域模式。
- 方案 B（降级）：html2canvas / dom-to-image 类库。**已知回归**：Mermaid foreignObject 污染 canvas——这正是当初弃用该路线的原因（`docs/archive/export-word-longimage_plan.md`），需重做 mermaid 栅格化并重新验证 4 个踩坑点。
- 有利条件：`export-bridge.ts` 契约 + 依赖注入使编排层不用动；`tmd:exporter-*` 五通道协议可映射为 Tauri event/command。

#### 缺口 3：PicGo 图床（`picgo` npm 包是纯 Node 库）

Tauri 无 Node 运行时，进程内库调用（`picgo.cjs`）不可用：

- 方案 A：Rust 重写常用图床上传（SM.MS/GitHub/OSS/COS 等），保留 picgo-config.json 格式兼容老用户——失去 PicGo 插件生态与「自定义 Web Uploader」兼容性。
- 方案 B：picgo-cli 作 sidecar（`plugin-shell`）——体积 +40~50MB，吃掉部分迁移收益。
- 方案 C：产品决策放弃/降级图床功能。

#### 其余小项

- crashReporter minidump：无对应，降级为 panic hook + 日志，或引入 sentry-crashpad（重）。
- 更新双源 failover（Gitee 失败切 GitHub）：`tauri-plugin-updater` 不内建，Rust 侧自写轮询。

## 4. 打包 / 发布 / CI 的变化（收益最大的部分）

现有 CI 复杂度大部分是**为 Chromium 的体积付费的**，迁移后大量直接删除：

| 现状 | 迁移后 |
|------|--------|
| dmg 85MB（为 Gitee 100MB 附件上限做 ULMO 重压缩 `patch-mac-dmg.mjs`） | 约 5–15MB，压缩/上限/重算 sha512 一套全删 |
| `trim-runtime.cjs` 裁语言包/GPU DLL/picgo mock | 整个不需要（无 Chromium） |
| blockmap 差量更新 | 无（updater 只全量），但包体小一个数量级，无感 |
| Squirrel.Mac 失效导致的 560 行 macOS 自研更新 | `tauri-plugin-updater` 直接替换 .app，**新增 minisign 签名密钥体系**（`latest.json` 替代 `latest.yml`，私钥进 CI secret） |
| Gitee raw 分发 + 配额清理 + 附件核对 | latest.json + 安装包仍可走 Gitee raw/附件，元数据格式重写；CDN 5 分钟缓存问题依旧 |
| DMG 自定义背景 + 图标坐标（`make-dmg-background.mjs`） | bundler 无配置，hdiutil/create-dmg 后处理脚本续命或放弃 |
| NSIS 自绘目录页（`installer.nsh`） | Tauri NSIS `installMode` + installerHooks 部分复用，需适配模板宏 |
| E2E（`desktop-harness` CDP 驱动真实窗口，39 断言） | CDP 不可用；tauri-driver 不支持 macOS WebDriver → Win/Linux WebDriver + mac 人工回归，或重点转向单测 |
| GitHub Release（gh CLI） | 原样复用 |

签名现状提示：当前 mac 为 ad-hoc 签名（`identity:"-"`）、Windows 未签名。Tauri updater 的 minisign 签名与代码签名是两回事，ad-hoc 下 updater 仍可用（清 quarantine 环节是否还需要待实测）。

## 5. IME 风险（易漏的一等风险）

仓库有 5 个 `ime-*` 探针脚本，说明在 Chromium 里已为中文输入法搏斗过。迁移后：

- **Windows：WebView2 即 Chromium 内核**，IME 行为基本一致，风险低。
- **macOS：换 WKWebView，CJK 输入行为与 Chromium 有已知差异**，对中文 Markdown 编辑器是必须真机回归的一等风险。
- Linux（WebKitGTK）：fcitx/ibus 兼容性是 wry 已知问题域；当前不发布 Linux，影响可控。

## 6. 工作量估算（单人，TS 熟练 + Rust 在学）

| 阶段 | 估算 | 备注 |
|------|------|------|
| Spike 技术验证 | 1–2 周 | 三缺口替代方案原型，go/no-go（§7） |
| 壳层基础：窗口/标题栏/菜单/主题/单实例/文件关联/最近文档/日志 | 2–3 周 | |
| 文件核心：编码读写/保存事务/历史/双 watcher/搜索/双链 | 3–4 周 | 指纹过滤是隐形深坑 |
| AI 模块 Rust 镜像 | 1 周 | |
| 导出：HTML/LaTeX | 0.5 周 | 几乎零成本 |
| 导出：PDF | 1–2 周 | Windows 可对标；macOS 是决策题 |
| 导出：Word/长图/ePub | 3–5 周 | 最高风险项，含 4 坑重验证 |
| PicGo 方案落地 | 1–2 周 | 随方案浮动大 |
| 打包/CI/更新体系重建 | 2 周 | 大量旧脚本删除 |
| 全量回归（IME / 导出 4 坑 / 三平台窗口行为） | 1–2 周 | |
| **合计** | **14–19 周** | 三件套降级或砍掉 → **7–10 周** |

## 7. 建议路径

1. **不要直接立项全量迁移。先做 1–2 周 spike**，只验证三件事：
   - WebView2 `PrintToPdfAsync` 原型（含页眉页脚降级设计）；
   - 隐藏窗口截图原型：跑通 `export-bridge.ts` 的 `CaptureRequest` 协议（WebView2 CapturePreview / WKWebView takeSnapshot 各出一版），验证隐藏窗口渲染不节流；
   - PicGo 取舍方向（Rust 重写范围 or sidecar or 砍）。
   这三个结论直接决定项目成败，其余部分都是确定性工程。
2. Spike 通过 → 全量迁移，按 §6 顺序推进：`native.ts` 契约与 70 通道语义不动，逐通道用 Tauri command/event 替换，前端 46 处调用点只在 `native.ts` 内部换实现。
3. Spike 不通过 → 留在 Electron 完全合理：Electron 44 维护良好，CI 复杂度已被自动化消化，迁移的机会成本主要是 3–4 个月功能停摆。

## 附录：参考资料

- wry issue [#707](https://github.com/tauri-apps/wry/issues/707)：静默打印 PDF（未实现）
- wry issue [#1358](https://github.com/tauri-apps/wry/issues/1358)：webview 截图能力（有 PR 未落地）
- [wry CHANGELOG](https://github.com/tauri-apps/wry/blob/dev/CHANGELOG.md)：截至 0.56.0 无 print_to_pdf / screenshot API
- Tauri 2 官方插件：single-instance / updater / dialog / fs / opener / log / window-state / store
- 项目内：`docs/archive/export-word-longimage_plan.md`（导出踩坑）、`docs/打包发布.md`、`docs/架构设计.md`
