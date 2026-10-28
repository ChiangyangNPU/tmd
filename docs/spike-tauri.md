# TMD Tauri 迁移进度与验证清单

> 版本：2.2　作者：chiangyang　更新：2026-10-28
> 状态：spike 四项验证通过；导出链双平台闭环（macOS objc2 + Windows WebView2 原语，
> 三格式真实链路验证通过）；Windows 侧进入收尾——**剩余硬缺口：PicGo 图床、自动更新、E2E 回归方案**
> 本文档的作用：记录 spike 验证结论、迁移进度（通道清单 / 模块映射 / 已知缺口）与后续验证项
> 相关文档：[Tauri迁移评估](Tauri迁移评估.md)　[架构设计](架构设计.md)　[打包发布](打包发布.md)

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
npm run tauri dev             # 开发：自动起 vite(5173) + cargo 构建 + 打开 WKWebView 窗口
npm run dist:tauri            # 打包：.app + dmg（产物在 src-tauri/target/release/bundle/）
npm run dist:tauri:dir        # 只出 .app 不出 dmg（--bundles app）
npm run dist:tauri:install    # 打包并覆盖安装到 /Applications/TMD-spike.app
```

> **安装名差异**：双壳共存期 Tauri 版装为 `TMD-spike.app`（identifier
> `com.chiangyang.tmd.spike`，userData 独立），**不覆盖**日常使用的
> Electron 版 `/Applications/TMD.app`；正式切换（v0.2.0，identifier 转正）
> 后该命令改回 `TMD.app`。体积实测见下文「体积实测」一节。

- 首次运行 cargo 拉全量依赖（rsproxy 不可用时官方 crates.io 实测直连畅通），之后增量构建秒级。
- 窗口加载的是 vite 开发服务器（`build.devUrl`）；`npm run tauri build` 则加载 `dist/` 生产产物。
- identifier 用 `com.chiangyang.tmd.spike`：userData 与已安装的 Electron 版**完全隔离**，随便折腾。
- 标题栏已对齐 Electron 观感（909392d Windows 侧 + mac 侧验证补全，见
  「标题栏对齐」一节）：mac 无原生标题条、红绿灯悬浮工具栏；Win 全自绘。

## 已实现（spike 范围）

> spike 四项验证已全部通过（2026-10-25），已合入 master 转入正式迁移；本节与
> 下节保留作为验证记录与后续验证清单。

- `src-tauri/src/main.rs`：窗口创建 + `initialization_script` 注入 `window.tmdAPI` Proxy 门面
- 已实现通道（50 条 invoke + 9 条事件订阅，与 `native.ts` 契约逐字段对齐，含 `isNative: true`；
  导出链新增：渲染层 `exportRun` / `print` + 导出窗内部 `exporterDone` / `exporterCapture` /
  `exporterReadImage` 三条与 `tmd-exporter-task` 事件下发）：
  `readFile` / `saveFile` / `readDir` / `openFile` / `openFolder` / `saveFileAs` /
  `exportAs`（对话框四件套走 tauri-plugin-dialog 的 Rust 侧 API，无需 capabilities 放行）、
  `searchFiles` / `wikiScan`、`watchFiles` / `watchDirs`、`listHistory` / `readHistory`、
  `setLocaleInfo`（重建菜单）/ `syncShortcuts` / `setAutosaveEnabled` / `setDirty` /
  `setThemeSource` / `winMinimize` / `winMaximizeToggle` / `winClose` /
  `recentSync` / `recentAdd` / `recentClear` / `recentRemove`、`ready` +
  订阅 `onFileChanged` / `onDirsChanged`（Tauri 事件 `tmd-file-changed` / `tmd-dirs-changed`）、
  `onMenu` / `onRecentOpen` / `onAutosave` / `onWindowMaximize`、
  `getAiConfig` / `saveAiConfig` / `testAiConnection` / `chatAi` / `abortAi` / `embedAiTexts`
  + 订阅 `onAiStream`（事件 `tmd-ai-stream`，requestId 关联 delta/reasoning/done/error）、
  `saveImage`（裸文件名白名单 + assets/ 落盘）/ `openExternal`（协议白名单）/ `openLocalFile` /
  `revealInFolder`（opener reveal）/ `deletePath`（trash 回收站）/ `createFile`（补 .md +
  wx 不覆盖）/ `createDir` / `renamePath`（fsops 名称清洗 + basename 二次防线）
- 纯逻辑模块化（与 electron/ 模块边界一一对应，JS 版保留服务 Electron 壳，改动需两处同步）：
  - `text_file.rs` ← `electron/text-file.cjs`（encoding_rs：BOM/UTF-16/GBK + CRLF）
  - `search.rs` ← `electron/search.cjs`（BFS 收集 / 跳过目录 / 扩展名白名单 /
    2MB·5000 文件·500 命中三重上限 / occurrence 定位协议；匹配在字符空间，
    中文行的 column 与 JS 的 UTF-16 口径一致）
  - `wikilinks.rs` ← `electron/wikilinks.cjs`（围栏跳过 / 三档解析 / ambiguous）
  - `watcher.rs` ← `electron/filewatcher.cjs + dirwatcher.cjs`（notify + 200ms 固定窗口
    防抖 + sha1 内容指纹过滤自身写入回声 + change 投递后重建 watcher 防 inode 失效 +
    CRLF 归一比对；emit 注入化，状态机脱壳单测）
  - `history.rs` ← `electron/history.cjs`（写前快照 / sha1 内容去重 / 单文件 50 条 +
    全局 200MB 双层剪枝 / 损坏 index 留档 7 天 / index 原子替换；**保存事务
    snapshot → write → note_write 三步在同一 Rust 命令内完成**，评估 §3.2 的要求落地）
  - `menu.rs` ← `electron/menu.cjs`（渲染层语言包驱动重建 / accelerator 用户自定义
    优先 / 最近文件子菜单含空占位 / 自动保存 checkbox；accelerator 解析失败降级无快捷键）
  - `ai_config.rs` ← `electron/ai-config.cjs`（服务商预设全走 OpenAI 兼容协议 / 字段
    白名单归一化 / 增量合并（context 嵌套单独合并、切服务商回落预设）/ **Key 存系统
    钥匙串（keyring）替代 safeStorage**，文件只落标记，降级路径同 JS；单测构建不触碰
    钥匙串，运行时首次访问可能弹一次授权）
  - `ai_client.rs` ← `electron/ai-client.cjs`（增量 SSE 解析容忍任意 chunk 边界 /
    HTTP 状态码错误码归一化 / 60s 空闲超时 / per-requestId CancellationToken /
    流内 error 结构归一化 / 嵌入 index 逐条校验）
  - `ai.rs` ← `electron/ipc-ai.cjs`（角色白名单 + 单条/总量双层体积上限 / invoke 立即
    返回 + 事件流推送 / 中止命中回执）
  - `fsops.rs` ← `electron/fsops.cjs`（名称清洗：隐藏文件/路径分隔/穿越/控制字符拒绝；
    Windows 保留字符与保留设备名平台差异按 JS 决策逐项保留——mac 半角冒号放行）
  - `themes.rs` ← `electron/themes.cjs`（单层扫描/防穿越读取/1MB 上限/空目录写示例
    主题/旧目录迁移：只增不覆盖 + 标记防复活）
  - `logger.rs` ← `electron/logger.cjs`（JSONL 按天滚动 / 7 天+10 个双层清理 /
    60 秒固定窗口去重汇总 / 字段白名单截断 / 崩溃线索 .seen-dumps 补记；
    **panic hook 写 main 来源日志**——Tauri 侧无 crashReporter 的替代闭环）
  - `shell.rs` 持久化段 ← `electron/shell-state.cjs`（主题来源 + 窗口几何，
    首帧前恢复；getNormalBounds 以「非最大化最近几何」自管近似；防抖 500ms
    代数去重 + Destroyed 同步兜底）
  - `export_assets.rs` ← `electron/export-assets.cjs`（KaTeX woff2 内联 data URI、
    woff/ttf 回退剔除、闭合标签转义大小写不敏感、OnceLock 缓存）
  - `shell.rs` ← `electron/app-state.cjs + recent.cjs + menu 装配`（菜单/快捷键/最近
    列表/脏标记/排序区域的权威状态；**脏文档关闭确认走原生对话框**，与 Electron
    同口径：拦截 CloseRequested → 放弃/取消，破坏性按钮不做默认）
- 未实现通道：no-op + console.warn（不阻塞启动；渲染层的 `!native` 降级判断不受影响）
- 单实例锁（tauri-plugin-single-instance）+ RunEvent::Opened 文件关联已接；
  CJK 排序：zh-CN 用 pinyin crate 全拼近似（zh-TW 的 ICU 注音/笔画序不可达，
  **降级为拼音序**——已知差异）；文件树与主题列表排序跟随界面语言
- spike 已知缺口：macOS appMenu 与编辑/视图 role 子菜单、系统最近文档注册
  （Jump List / Dock）、zh-TW 注音/笔画序（降级拼音）、原生 crashReporter
  minidump 生成（仅保留线索扫描）
- Rust 单测 66 例（文件核心 23 + 菜单 4 + AI 14 + fsops 4 + 主题 8 + 导出资源 3
  + 日志 6（轮转/截断/白名单/归一化/去重窗口/崩溃扫描）+ 持久化与排序 4）
- 窗口由 Rust 侧 `WebviewWindowBuilder` 创建（而非 tauri.conf.json）——因为 initialization_script
  只能走 builder，这也是正式迁移的必经形态。

## 体积实测（2026-10-25，release 全量优化）

| 产物 | Tauri | Electron（对照） |
|------|-------|------------------|
| 安装包 dmg | **6.1 MB** | 80 MB（↓92%） |
| .app 安装后 | **8.6 MB** | 约 238 MB（↓96%） |
| 裸二进制 | 8.3 MB（含 brotli 压缩内联的前端产物） | —（Chromium 约 220MB 不可压缩） |

release 配置：`opt-level = "s"` + LTO + `codegen-units = 1` + strip；
前端产物（dist 11MB，含 KaTeX 字体与 Mermaid 全量 chunk）由 tauri-codegen
brotli 压缩后嵌入二进制。release 启动冒烟通过。

## 双壳 GUI 验收（2026-10-25，桌面自动化实测）

测试工作区：/tmp/tmd-acceptance（Mermaid/KaTeX/代码块/表格/任务列表/脚注/
高亮/上下标/front matter/双链综合文档 + 多音字文件名 4 个 + GBK 文件 + CRLF
文件），Tauri 版（/Applications/TMD-spike.app）经桌面自动化（辅助功能 +
截图）逐项实测：

| # | 验证项 | 结果 |
|---|--------|------|
| 1 | 启动首帧（自绘标题栏/工具栏/标签栏/空编辑器） | ✅ 与 Electron 版视觉一致 |
| 2 | 原生菜单构建（文件/导出/格式全项 + 最近文件空占位） | ✅ 内容正确 |
| 3 | **文件关联打开**（open 命令 → RunEvent::Opened → 单实例转交 → 渲染层） | ✅ 全链路 |
| 4 | **Mermaid SVG 实时渲染**（流程图 + 分支标签） | ✅ |
| 5 | **KaTeX**（行内 E=mc² + 块级积分式） | ✅ |
| 6 | 代码高亮（Rust token）/ 表格 / 任务列表 / 脚注 / 高亮 / 上下标 / front matter 属性表 | ✅ |
| 7 | **双链三件套**（[[目标]] / [[\|别名]] / [[#锚点]]） | ✅ |
| 8 | 多标签页（3 个文件同开、切换） | ✅ |
| 9 | **GBK 解码**（encoding_rs 兜底，35 字无乱码） | ✅ |
| 10 | **GBK 编码写回**（编辑后 Cmd+S，xxd 验证落盘仍是 GBK 字节、UTF-8 解码失败） | ✅ |
| 11 | CRLF 文件打开渲染 | ✅ |
| 12 | 字数统计 / 标签标题同步 | ✅ |

### 验收发现

- **macOS 菜单布局差异（已知缺口确认）**：muda 把首个子菜单（文件）作为
  应用菜单显示为「TMD」，且无编辑/视图 role 菜单——功能不受损（webview
  原生响应编辑快捷键），菜单结构待正式版对齐
- **自动化方法论教训**：macOS 菜单/后台文件面板会忽略合成指针点击
  （坐标降级点击曾误触「另存为」），须用键盘导航（方向键 + Return）或
  AXOpen；后台面板的键盘输入也被静默忽略——GUI 自动化应优先走
  文件关联（open 命令）等非对话框路径
- **待人工复核**：文件夹挂载后的文件树 CJK 排序对比（对话框自动化受阻，
  挂载链路本身已由单测与「打开文件」链路间接覆盖）、搜索面板、图谱

## 导出原语验证（阶段 B，2026-10-25，判定：**GO**）

评估 §3.3 判定「wry 无 printToPDF / capturePage 等价物、macOS WKWebView 无 PDF API」。
原型（`src-tauri/src/export_native.rs`）验证了绕过路径：`with_webview` 取 WKWebView
原生指针 + objc2 直调，**两个原语都工作**，且 macOS WKWebView **有** PDF API
（`createPDFWithConfiguration`，macOS 11+，评估的「无 API」判定被推翻）：

| 原语 | 原生 API | 对齐 Electron | 实测结果 |
|------|----------|---------------|----------|
| 全文档 PDF | `createPDFWithConfiguration`（rect 为 **web page 坐标**，设全文档尺寸一次调用出整页多段） | `printToPDF` | ✅ 50772 字节 PDF，真实内容（综合演示文档首页段） |
| 视口截图 | `takeSnapshotWithConfiguration`（rect 为 view 坐标，仅视口） | `capturePage` | ✅ 2560×1640@2x PNG，编辑器完整内容 |

验证方法：`/Applications/TMD-spike.app` 经文件关联打开综合文档 → 菜单键盘导航触发
「Spike: 全文档 PDF 导出 / Spike: 视口截图」（导出菜单两项原型入口）→ 产物四重交叉
验证：像素统计（15.4% 非白、1907 色）+ 27 条文本行带 + 与屏幕地面真值（
`screencapture` 窗口定向截图）二值化最优对齐相关 **0.658**（约 24pt 纵向偏移，
Mermaid 异步渲染完成前后所致）+ 视觉模型内容描述与地面真值逐元素一致（工具栏
450 字 / YAML 卡片 / H1 / Mermaid 流程图分支标签全对）。

> 佐证教训：PNG 曾被视觉模型误判「纯白」——实为回取 CDN 的 URL 签名已过期，
> 模型看到的是错误页。产物验证一律以**本地像素分析**为准，远程回看不可信。

### 约束与教训（正式迁移必读）

- **可见性约束（评估预言的隐藏窗口节流，实测确认）**：后台启动（`nohup`/`&`，
  窗口从未上屏）两个原语都只出空白（PDF 3705 字节 / PNG 全白）；`open -a`
  激活、窗口真实上屏后都出真实内容。正式迁移的导出由用户主动触发、窗口可见，
  天然满足；保险策略：捕获前确认窗口 `visible` + 等待渲染沉降（Mermaid 等
  异步内容完成后）。**不要尝试隐藏窗口截取**，评估文档的该风险预言成立
- **autoreleased 回调对象必须 `Retained::retain_autoreleased`**：
  `evaluateJavaScript` 结果 / `takeSnapshot` 的 NSImage / `representationUsingType`
  的 NSData 三处——误用 `from_raw` 会过度释放 → SIGTRAP 无输出崩溃（空 stderr，
  靠逐步日志二分定位，本次最难查的问题）
- **`msg_send` 选择器不可合并**：`NSBitmapImageRep` 的 alloc → `initWithCGImage`
  → `representationUsingType:properties:` 是三个独立调用，合并选择子直接 SIGTRAP
- **argv 文件打开必须 ready 门控**（`PendingOpenPaths.ready`）：渲染层 ready 前
  flush 打开事件无人接收 → 文档没打开 → 捕获自然空白（对应 Electron
  `app.isReady()` 语义）
- **内容尺寸选择器**：TMD 编辑器是定高容器，`documentElement.scrollHeight`
  返回的是视口高（本次 788px，故 PDF 实为首页视口段而非全文档）——正式迁移
  量全文档高度须用 `.ProseMirror` 节点的 scrollHeight
- 原型入口保留至正式导出通道落地：「Spike:」菜单项与 `TMD_SPIKE_EXPORT=1`
  启动 8 秒自动跑（均仅 spike 壳内，不影响 Electron 壳）；届时替换为
  `export-bridge.ts` 既有契约（分段滚动 + 拼接，长图管线与 Electron 同构）

### 导出窗口形态矩阵（2026-10-25，正式形态已定：屏边探出）

Electron 离屏导出 = 隐藏窗口 + `backgroundThrottling:false`。WKWebView 无此开关，
矩阵实验（`src-tauri/src/export_probe.rs`，`open --env TMD_SPIKE_MATRIX=1` 触发，
加载真实 export-renderer.html + 注入渐变/大字探针）：

| 指标 | V1 隐藏窗（visible=false） | V2 屏边探出（60px 探边，余在屏外） |
|------|--------------------------|-----------------------------------|
| takeSnapshot / createPDF 内容 | ✅ 强制合成有效（98.3% 非白） | ✅（98.3% 非白） |
| requestAnimationFrame | ❌ 冻结（1.2s 未触发） | ✅ 正常逐帧 |
| document.visibilityState | `hidden` | `visible` |

- **修正阶段 B 结论**：可见性约束实际在「应用激活」层（激活应用内隐藏窗
  也能截到内容）；但隐藏窗的页面**渲染循环被冻结**——export-renderer.ts 的
  `nextFrames()` 会永久挂起，任务必超时 → 隐藏窗不可用
- **正式形态 = V2 屏边探出**：窗口左 60px 探在屏内维持 occlusion visible，
  其余置屏外（位置 = 屏宽−60），用户几乎无感；rAF / visibilityState / 捕获
  全部与 Electron 行为同构。多显示器时定位到**最右侧屏幕**的右边缘
- 附带验证：export-renderer.html 在 Tauri 壳内正常启动；无 exporterAPI
  桥接时静默空转（`if (window.exporterAPI)` 守卫生效）

## 导出链正式实现（2026-10-25，长图端到端已验证）

`src-tauri/src/exporter.rs` 对齐 electron/exporter.cjs 薄壳分工：壳只管窗口
生命周期与平台原语，编排仍全在离屏页 export-renderer.ts（零改动共用）。

- **通道**：`tmd_export_run`（保存框 → 队列 → 落盘）、`tmd_exporter_done`
  （base64 字节回传，JSON IPC 下体积 4/3 而非数字数组的 ~6 倍）、
  `tmd_exporter_capture`（视口模式 set_size+滚动定位+整帧；区域模式 rect 截取，
  对齐 capturePage 两形态）、`tmd_exporter_read_image`（扩展名白名单 + 32MB
  上限 + data URI）、`tmd_print`（createPDF 降级路径，见下）
- **窗口**：专职 worker 线程 + mpsc 串行队列；任务结束即销毁探边窗（不留
  常驻边条），异常/超时销毁自愈（与 Electron destroyWindow 同策略）
- **桥接**：初始化脚本注入 `exporterAPI` 门面（onTask/taskDone/capture/
  readImage），export-renderer.ts 的 `if (window.exporterAPI)` 守卫零改动命中
- **端到端验证**（`open --env TMD_SPIKE_EXPORT_RUN=1`，8s 后最小 longimage
  任务走真实链路）：探边窗 → 任务事件 → 页面管线（KaTeX/字体/Mermaid
  等待）→ 2x 分段截图 → canvas 拼接 → base64 回传 → **/tmp/tmd-export-verify.png
  83273 字节**，像素核验 1848×560（= 924×280 CSS × 2x）、4301 红色标题像素
  （h1 #b00020 真渲染）、白底黑字分布正常

### 实现过程中排掉的四个坑（复用价值高）

1. **capabilities 窗口覆盖**：Tauri 2 权限系统按窗口 label 放行——导出窗
   不在 capabilities 里则 invoke/listen 全被拒（症状：任务下发后页面 180s
   无响应超时）。`capabilities/default.json` 的 windows 数组须含 `tmd-exporter`
2. **同步命令跑在主线程**：capture 命令里 `with_webview` 又把闭包派发回主
   线程并阻塞等回传——主线程自等死锁，症状恰为 evaluate 10s 超时。凡有
   eval/截帧的命令必须 `async fn` + `spawn_blocking`
3. **takeSnapshot 默认 afterScreenUpdates=true 等新一帧**：探边窗屏内仅
   60pt，滚动常只改屏外部分 → 等不到屏内新帧 → 永不回调（30s 超时）。
   `setAfterScreenUpdates(false)` 取当前已提交状态（调用方本就显式沉降）
4. **焦点即渲染循环**：`focused(false)` 的探边窗行为非确定性（rAF/eval
   时通时挂）；`focused(true)` 后稳定通过——探边窗必须成为 key window。
   UX 代价：导出期间短暂抢焦点（Electron 无感），后续 polish 项

### 已知降级与待办

- **print（PDF）**：macOS 无 printToPDF 等价物，走 createPDF 全文档直出——
  **页尺寸/页边距/页眉页脚/大纲选项暂不生效**（渲染层 PdfOptions 保留入参）；
  语义为「连续版式 PDF」。是否补打印管线（分页 CSS 或系统打印面板）待定。
  **Windows 侧无此降级**：PrintToPdf 走 Chromium 打印管线，@page / 页尺寸 /
  朝向 / 页边距 / 页眉页脚均生效（见下节），仅「大纲书签」无对应项
- **Word / ePub**：与长图共用同一条链（区域截图公式栅格化 + readImage 图片
  本地化），链路已由长图端到端验证背书；**Windows 真实链路已验证三格式
  闭环**（82d808d：docx 14774 字节含 OMML 结构化公式与栅格化 Mermaid、
  epub 5129 字节 mimetype/OPF/nav/XHTML 全对、longimage 99873 字节）；
  正式 GUI 验收（真实菜单 + 保存框）仍建议人工点一轮 Word/长图/PDF 三项
- **GUI 验收待做**：导出菜单 → 保存框 → 落盘的全 UX 路径（自动化面板键盘
  输入受限，建议人工点一轮）；Windows NSIS 安装包已可出包
  （`npm run dist:tauri:win`，见打包发布.md §10.1）
- 超时尸检与桥接心跳（`__tmdSteps`）为验证期观测手段，保留至 GUI 验收后

## Windows 侧迁移（2026-10-28，导出链与打包闭环）

评估 §3.3「Windows 导出原语未验证」已拔掉，Windows 从「以 macOS 结论为准」
转为独立可交付：

- **导出原语**（`export_native_win.rs`，与 export_native.rs 同签名、main.rs
  `#[path]`+cfg 切换，exporter.rs 编排层零分叉）：JS 执行 `ExecuteScript`、
  截图 `CapturePreview`（无 rect 参数——区域模式截全视口后按 devicePixelRatio
  换算裁剪）、PDF `ICoreWebView2_16::PrintToPdf`（临时文件直写后读回）。
  线程模型与 mac 一致：COM 对象不跨线程，completion 回调经 mpsc 交回调用线程
- **三格式验证闭环**（82d808d）：exporter.rs `verify_pipeline` 重构为
  longimage / word / epub 依次跑真实链路，Windows 实测产物全部结构正确
  （见上节「已知降级与待办」引的数据）
- **NSIS 打包**：`npm run dist:tauri:win` 三件套（build / dir / open），
  `TMD_0.2.0-spike.1_x64-setup.exe` 冒烟通过；打包发布.md 新增 §10.1 Windows 段
- **拖拽路径接线**（82d808d）：Tauri `dragDropEnabled` 拦截下 HTML5 drop 不带
  文件——shim 增 `onDropPaths`（tauri://drag-drop）+ 新命令
  `tmd_read_dropped_file`（图片扩展名白名单 + 32MB 上限）渲染层构造 File
  复用粘贴链；md 按路径打开与 Electron 同款去重/最近列表
- **壳缺陷修复三连**（c3df526 / 6f6aee2 / 5653129）：release 弹 CMD 窗口 +
  拖拽文件不打开；watcher 基线读盘竞速（noteWrite 指纹自身保存误报外部修改）；
  首帧闪原生菜单（菜单改仅 macOS 实挂 + 渲染层 keydown 兜底，见下节缺口）
- **快捷键真机全量检测**（f4f658f，2026-10-28）：28 键逐一发送 + 截图留证，
  暴露并修复两处渲染层缺陷——① fmt-* 双触发：`formatKeymap` 命中后事件仍
  冒泡到 main.ts 通用兜底再执行一次，切换类命令一加一撤等于没生效（修复：
  命令生效即 `stopPropagation`）；② Shift+数字/符号主键失配：`e.key` 是位移后
  字符（Shift+8='*'），与配置主键永不相等，无序列表/有序列表/上标/下标结构性
  失效（修复：按 `e.code` 物理键位还原）。浏览器模式端到端复现并验证
- **CI**：Rust 双平台编译门禁（mac + win matrix，36023c2）；mac 编译修复
  （a2f82ff，capture_full_pdf 新参调用点补 None）

## 标题栏对齐（909392d Windows 侧实现，2026-10-27 mac 侧验证补全）

对齐 electron/main.cjs:373-376 的双平台观感（main.rs 主窗口 builder 平台 cfg 门控）：

- **Win/Linux**（= Electron `titleBarStyle:'hidden'`）：`decorations(false)` 全自绘，
  `html.win .win-controls` 按钮走既有 tmd_win_* 命令；Windows 侧实测通过（909392d）
- **macOS**（= Electron `hiddenInset` + `trafficLightPosition(16,16)`）：
  `TitleBarStyle::Overlay` + `hidden_title` + `traffic_light_position(16,25)` +
  tauri.conf `macOSPrivateApi`。**实测（2026-10-27）**：原生标题条消失、工具栏
  顶到窗口顶、红绿灯圆心 (22.8,22.8) 与 Electron 目标 (23,23) 对齐（亚像素级），
  与工具栏文本带中心（21.5）垂直居中；文档关联打开回归通过（213 AX 元素）

### mac 侧验证发现（Windows 侧盲写代码的三处修正）

1. **traffic_light_position 语义 ≠ Electron**：x 为按钮原点（圆心=x+7），y 直接
   映射圆心高度（实测圆心≈y−2.2，判别实验 y=16→13.8 / y=40→37.8 线性校准）。
   Electron (16,16) 圆心在 (23,23) → Tauri 应配 **(16,25)**（909392d 原值 16,16
   在 mac 上会偏高 7px）
2. **扩大的虚拟标题栏容器不拦截内容点击**（wry 把容器扩到 14+y 高实现 y 下移；
   y=40 实测工具栏按钮仍可点）——红绿灯放任意深度都安全
3. **原生标题栏行为全部穿透**（单击/拖拽/双击都到不了原生层）：拖拽由 shim 的
   mousedown→start_dragging 承担（三平台）；双击最大化原仅 html.win 门控——
   mac 原生缩放不会触发（穿透），已放开为三平台统一接管（mac 系统偏好
   「连按两下」非默认值不跟随，按 Electron 默认语义缩放）

待人工复核：真实鼠标拖拽工具栏移窗、双击最大化（合成事件因 invoke 异步
延迟 / dblclick 时间阈值无法自动化验证，机制与 Windows 实测版同源）。

## 首帧防闪（2026-10-28，mac 补全）

Electron 版用 `show:false` + `ready-to-show` + `backgroundColor` 三件套消除启动
白闪。Tauri 侧此前只有 Windows 分支做了隐藏创建（f4f658f），**macOS 窗口立即
上屏**，WKWebView 首帧绘制前露出默认白底——暗色/自定义预设主题下启动先闪白
再切主题（用户实测）。

修复（main.rs 主窗口 builder，三平台统一）：

- **隐藏创建** `visible(false)` 提为跨平台；上屏通道：
  - Win/Linux：页面加载完成 `on_page_load(Finished)`（boot.js 同步挂好深浅
    类与预设属性，工具栏已可绘制）
  - 三平台共有：渲染层 `ready`（boot 末尾，文件主题经 IPC 异步注入完毕）经
    `flush_pending_open_paths` 的 show 上屏。macOS **只**走这条——boot 中的
    `await restoreFileTheme` 晚于页面加载完成，提前上屏会闪内置配色
  - 兜底：8s 看门狗强制 show（页面加载失败时窗口不能永久隐藏）
- **主题底色** `background_color`（dark #1e2127 / light #ffffff，对齐 Electron
  SHELL_BG）：兜底「已上屏但首帧未合成」瞬间露出的也是主题色而非白
- 验证：暗色主题下爆发截帧（60 帧 × ~90ms）无任何白亮帧，窗口出现即主题色；
  浅色预设主题恢复后渲染正常；72 测试全绿

## 缺口清单（2026-10-28 盘点）

> 通道面精确对账：shim 实现 **59 条**，`native.ts` 契约 **69 条**，差集 11 条——
> 其中 `getPathForFile` 属**有意替换**（Tauri 走 `onDropPaths` + `readDroppedFile`，
> Electron 的 `webUtils.getPathForFile` 在 WebView2 无对应），其余 10 条落在
> 下面 A 组两条硬缺口里。未实现通道在 shim 里是 **no-op + 一次性 console.warn**
> （`[tmd-tauri-spike] 通道未实现（no-op）`）——不崩、不阻塞启动，但**功能静默无效**。

### A. 硬缺口（功能不可用，必须解决才可转正）

| # | 缺口 | 现状 | 影响 | 候选方案 |
|---|------|------|------|----------|
| 1 | **PicGo 图床上传**<br>3 条通道：`uploadImage` / `getPicGoConfig` / `savePicGoConfig` | 全部 no-op；`electron/picgo.cjs`（121 行，纯 Node 库）是唯一实现，Rust 侧零代码 | Tauri 版**粘贴图片上传图床整块不可用**，设置面板配置保存也不落地 | ①Rust 重写（7 家图床取舍，评估 §3.3 缺口 3）②sidecar 打包 Node 运行时（体积 +60MB，抵消迁移收益）③产品降级：Tauri 版仅本地 assets/，上传入口按能力隐藏 |
| 2 | **自动更新**<br>7 条通道：`checkForUpdates` / `downloadUpdate` / `installUpdate` / `onUpdateStatus` / `setAutoCheckUpdate` + 保存重启握手 `onSaveRequest` / `reportSaveResult` | 全部 no-op；`electron/updater.cjs`（Gitee + GitHub 双源、差量 blockmap、附件配额清理）无 Tauri 对应物；**`tauri-plugin-updater` 未引入**（Cargo.toml 仅 dialog / single-instance） | Tauri 版**无自动更新**，用户只能手动下安装包；「保存并重启」流程同样不可用 | ①`tauri-plugin-updater` + 自建 update.json（全量下载，失去差量）②双源 + minisign 校验 + 差量自研（工作量大）③转正初期只支持全量更新 |
| 3 | **E2E 回归方案** | `scripts/desktop-app-check.mjs` 依赖 Electron CDP（`--remote-debugging-port`），Tauri WebView2/WKWebView 不可用 | **无自动化 GUI 回归**；本次快捷键 bug 就是靠人工脚本 + 截图排查的 | ①`tauri-driver` + WebDriver（Windows 较好，mac 依赖 WebDriverAgent）②单测下沉：渲染层逻辑抽纯函数补测——f4f658f 已按此思路补 6 例③人工验收清单（当前实际做法） |

### B. 平台差异与降级（功能可用但不完全等价）

| # | 项 | Tauri 现状 | Electron 对照 | 备注 |
|---|----|------------|---------------|------|
| 1 | **Windows 原生菜单** | **未实挂**——菜单仅 macOS 构建；Windows 靠渲染层 keydown 兜底分发（5653129） | 全平台原生菜单 | 修复目标是不闪首帧；代价是 Windows 无菜单栏（⋯ 按钮 + 快捷键代替）。是否补原生菜单待产品决策 |
| 2 | **macOS PDF 选项** | createPDF 连续版式，页尺寸/边距/页眉页脚/大纲**不生效** | printToPDF 全选项 | Windows 侧 PrintToPdf 全生效，仅大纲无对应 |
| 3 | **macOS 菜单结构** | muda 把「文件」子菜单当应用菜单显示为「TMD」，无编辑/视图 role 菜单 | 标准 macOS 菜单栏 | 功能不受损（webview 原生响应编辑快捷键） |
| 4 | **zh-TW 排序** | pinyin crate 全拼近似，注音/笔画序**不可达**（降级拼音序） | ICU 完整排序 | zh-CN 拼音序正确 |
| 5 | **系统最近文档** | 未注册（Jump List / Dock 最近项） | `app.addRecentDocument` | 应用内最近列表正常；系统级集成缺失 |
| 6 | **原生 crashReporter** | 无 minidump 生成，仅 panic hook 写日志 + 崩溃线索扫描（`.seen-dumps`） | crashReporter 上传 | 崩溃可定位但无堆栈转储 |
| 7 | **导出期间抢焦点** | 探边窗 `focused(true)` 才稳定（export_probe 矩阵结论）；导出瞬间短暂抢焦点 | 隐藏窗无感 | UX polish 项，非阻塞 |
| 8 | **`getPathForFile` 通道** | 无（有意替换） | `webUtils.getPathForFile` | Tauri 走 `onDropPaths` + `readDroppedFile`，语义等价 |

### C. 转正前的收尾工作

1. **identifier 转正**：`com.chiangyang.tmd.spike` → `com.chiangyang.tmd`，安装名 `TMD-spike.app` → `TMD.app`；userData 迁移（或明确告知用户重新配置）
2. **双壳下线**：`electron/` 目录 27 个模块（约对应 16 个已 Rust 化的纯逻辑模块 + 壳自身 + PicGo/updater 两个未迁移件）在 Tauri 转正后归档；`native.ts` 契约层的 Electron 分支保留还是清理需决策
3. **版本号对齐**：`package.json` 0.1.6 / `tauri.conf.json` 0.2.0-spike.1，转正时统一
4. **GUI 验收清单**（人工，一次性）：导出三格式走真实菜单+保存框、文件夹挂载后 CJK 排序对比、搜索面板、图谱、真实鼠标拖拽移窗/双击最大化
5. **发布流水线**：Windows NSIS 已可出包，但 release 工作流（Gitee 双源上传、附件配额清理）仍是 Electron 口径，需按 Tauri 产物重写

## 判定与去向

- 验证 1–4 通过 → 按评估 §6 顺序在 master 双壳共存迁移（不拉长分支，理由见评估与迁移讨论）——**已执行**
- 阶段 B 导出原语验证通过（macOS）→ 导出链正式迁移放行——**已执行**；
  Windows 等价原语**已验证**（`export_native_win.rs`，PrintToPdf 反而优于 mac 的 createPDF）
- 验证 2（IME）失败且无 workaround → 停止迁移，Tauri 评估结论作废，Electron 路线继续——**未触发**（IME 验证通过）
- 验证 1/3/4 有缺口但验证 2 通过 → 评估工作量重估后再决策——**未触发**

### 当前判定（2026-10-28）

双平台壳与导出链都已闭环，迁移主体完成。**转正（v0.2.0）的阻塞项收敛为
缺口清单 A 组三条**：PicGo 图床、自动更新、E2E 回归方案。其中：

- PicGo 影响「粘贴图片 → 自动传图床」这条常用链路，属功能回归，**须先定方案**
  （推荐先产品降级：Tauri 版明确标注仅本地图片，把 Rust/sidecar 方案留到 v0.2.x）
- 自动更新可先用 `tauri-plugin-updater` 全量方案顶上，差量优化后置
- E2E 方案不阻塞发版，但**转正后没有它 GUI 回归只能人工**——建议随转正一并落地
  tauri-driver 最小骨架

B 组为平台差异，可带病转正（清单内逐条记录即可）；C 组为转正动作本身。
