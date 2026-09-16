# 导出 Word / 长图 实施计划

## 仓库调研

### 现有导出架构（src/export.ts + electron/main.cjs）

- `src/export.ts` 是纯函数管线：`renderMarkdown`（内部 mdIt 实例，含脚注/高亮/上下标插件、`<img>` HTML 还原、mermaid fence 标记、标题 slug）→ `buildExportHtml`（注入主题变量快照 `:root` + `EXPORT_CSS` 样式表 + **Mermaid/KaTeX 走 CDN**）。
- HTML 导出：渲染层拿 HTML 字符串 → `native.exportAs({content, defaultName, filters})` → 主进程 `dialog.showSaveDialog` + `fs.writeFile(utf-8)`；浏览器环境降级为 `<a download>`。
- PDF 导出：`native.print()` → 主进程 `mainWindow.webContents.print({printBackground:true})`，打印的是编辑器当前 DOM（`@media print` 隐藏 UI）。
- 主进程窗口：`contextIsolation:true / nodeIntegration:false / sandbox:false`（preload 需 require ipc.cjs）；开发 `loadURL(ELECTRON_RENDERER_URL)`，生产 `loadFile(dist/index.html)`。
- CSP 仅注册在 `session.defaultSession`（onHeadersReceived）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'`。
- 契约三层：`electron/ipc.cjs` 通道常量（受 `src/native.ts` 的 `IpcChannels` 接口 tsc 约束）→ `electron/preload.cjs` 暴露 → `src/native.ts` 类型；浏览器环境 `native === undefined`，各功能按既有惯例降级（文件式主题区即整区隐藏）。
- 菜单：主进程 `Menu`（三语 L()，accelerator 经 shortcuts 配置）→ `sendToRenderer(IPC.menu, action)`；渲染层 main.ts 统一 action 分发；工具栏 ⋯ 菜单（index.html `#more-menu`）目前只有"导出 HTML"。
- 图片：当前标签 `activeTab().path` 给目录取 `baseDir`（image-resolver.ts 同源）；文档中图片为 `assets/x.png` 相对路径、data: URI 或 http(s)。
- 依赖现状：`mermaid@11.17.2`、`katex@0.16.47`（@milkdown/plugin-math 的传递依赖，顶层提升但未显式声明）均在 node_modules；vitest 环境为 `node`（无 DOM，单测须面向纯函数）；electron-builder `compression:'maximum'`，现安装包 93.39MB / Gitee 100MB 上限。

### 关键约束推导

1. **Mermaid/KaTeX 在导出产物中是动态渲染**：HTML 文件靠 CDN（打开时才渲染）；Word/长图必须拿到"已渲染的结果"，需要一个真实 Chromium 离屏环境。
2. **离屏环境必须离线可用**（项目原则）：离屏页本地打包 mermaid/katex，不用 CDN。
3. **default session 的 CSP 不允许 file/http 图片、不适合导出页**：离屏窗口须用独立内存 partition + 专用 CSP。
4. **Word 转换器只吃 inline style**：导出版式在样式表与 CSS 变量里，浏览器端 `getComputedStyle` 方案（dom-docx `styleSource:'computed'`）可免自写样式内联层；复杂 SVG（Mermaid）必须栅格化（dom-docx `rasterizeInPlace`）。
5. **整页截图受 Chromium 纹理上限约束**（单帧约 16384 物理像素）：长图须分段截图 + canvas 拼接。

## 架构与设计模式

沿用项目既有范式（search.cjs/themes.cjs：纯 Node 逻辑 + 薄 IPC 包装；theme-presets.ts：纯函数核心 + DOM 副作用薄层），新增部分按以下模式组织：

1. **单一数据源（DRY）**：从 export.ts 抽出 `buildExportDocument()`（正文 HTML + 变量块 + EXPORT_CSS + 标题），现有 CDN 外壳 HTML 导出与新离屏页共同消费，导出样式与 Markdown 管线只有一份。
2. **离屏渲染服务（单例 + 串行队列）**：`electron/exporter.cjs` 管理一个 `show:false` 的 BrowserWindow（独立内存 partition、专用最小 preload、拦截导航、显式 CSP）；导出低频，任务串行排队，窗口复用（避免重复加载 mermaid/katex）。
3. **命令模式——能力原语下沉主进程，编排留在 TS**：主进程只暴露 Electron 独有原语（保存对话框/写文件/视口设置+截图/读本地图片），任务流程（渲染、等待、测量、分段、拼接、docx 转换）全部在离屏页 TS 侧，使业务逻辑可被 vitest 覆盖；exporter.cjs 保持薄壳。
4. **策略模式**：离屏页按任务 kind 路由 `word` / `longimage` 两个处理器，共用同一条渲染管线与任务协议。
5. **适配器**：Word 路径在转换前做有限适配（图片 src 解析、独占公式栅格化、转换器不支持元素的兜底），转换器本体藏在 `src/export-word.ts` 单一函数之后，**替换引擎不动其他文件**。
6. **安全边界**：离屏页无 Node 权限、contextIsolation；本地图片经主进程白名单通道读成 data URI（仅绝对路径 + 图片扩展名，仿 themes.cjs 路径校验），http(s) 图片由离屏页直接 fetch；拒绝 javascript: 等协议。

## 文件与模块

### 新增

- `export-renderer.html`：离屏页 HTML（Vite 第二入口，仅 #export-root + 模块脚本，无任何 UI 框架）。
- `src/export-renderer.ts`：离屏页引导——订阅任务 IPC、注入文档、调用 word/longimage 处理器、回传结果（Uint8Array）。
- `src/export-doc.ts`：从 export.ts 抽出的共享核心（EXPORT_CSS、buildExportDocument），新增纯函数 `resolveExportImageSrc(src, baseDir)`（相对→file:// 绝对；data/blob/http/https/file 原样；危险协议返回 null）。
- `src/export-word.ts`：Word 适配 + 转换（本地 mermaid.run + katex auto-render；等待图片；`.katex-display` foreignObject 2x 栅格化；dom-docx `convertHtmlToDocx`，computed + rasterizeInPlace + imageResolver + onWarning）。
- `src/export-image.ts`：长图纯逻辑——`planSegments(heightCss, dpr, zoom)`（分段偏移/高度，单段物理高 ≤8000，总物理高 ≤120000 拒绝）与 canvas 拼接函数。
- `electron/exporter.cjs`：隐藏窗口单例、串行队列、partition/CSP、三个原语（保存+写入合并由调用方 exportRun 完成；capture；readImage）。
- `electron/exporter-preload.cjs`：最小 preload（onExportTask / capture / readImage / done 四个桥）。
- 测试：`src/__tests__/export-image.test.ts`（分段）、`src/__tests__/export-doc.test.ts`（图片路径解析）。

### 修改

- `vite.config.ts`：`build.rollupOptions.input` 增加 `export-renderer.html`。
- `electron/ipc.cjs` / `src/native.ts`（IpcChannels + NativeFileAPI）/ `electron/preload.cjs`：新增 5 通道（见下）。
- `electron/main.cjs`：主菜单「导出」加两项（无 accelerator）；require 并初始化 exporter 服务。
- `src/export.ts`：抽出共享核心后 re-export 保持现有引用不变；新增 `exportWord()` / `exportLongimage()` 编排（构造 payload、调 native、toast 反馈、取消静默）。
- `src/main.ts`：onMenu 增加 `export-word` / `export-longimage` 分发；⋯ 菜单两个按钮事件；浏览器环境隐藏两项。
- `index.html`：`#more-menu` 增加两个 `.menu-item`。
- `src/locales/zh-CN.json / zh-Hant.json / en.json`：菜单与 toast 文案键。
- `package.json`：新增 devDependency `dom-docx`（**精确版本 1.0.1，不带 ^**）、显式声明 `katex`（对齐 0.16.x，消除传递依赖隐忧）。
- 文档：路线图、详细设计、架构设计（IPC mermaid 图/模块表）、需求说明、双语 README。

### IPC 通道（5 条）

| 通道 | 方向 | 用途 |
|---|---|---|
| `export-run` | 主窗口 → 主（invoke） | 载荷 `{kind, title, bodyHtml, varsBlock, css, isDark, baseDir, defaultName, filters}`；主进程先弹保存框（取消即返回 null 不启动任务），再下发任务并 await 最终写入 |
| `exporter-task` | 主 → 离屏页（send） | 任务下发（同上载荷，去掉对话框字段） |
| `exporter-done` | 离屏页 → 主（invoke） | `{ok:true, bytes:Uint8Array}` 或 `{ok:false, error}`；主进程写目标文件后 resolve export-run |
| `exporter-capture` | 离屏页 → 主（invoke） | 原语：`{widthCss,heightCss,scrollYCss}` → 主进程 setContentSize + 滚动 + `capturePage()` → `{dataUrl, physicalWidth, physicalHeight}` |
| `exporter-read-image` | 离屏页 → 主（invoke） | 原语：file URL → 主进程校验后读文件 → `{dataUri}` / null |

## 实施步骤（依赖序）

1. **依赖**：安装 `dom-docx@1.0.1`（精确）、`katex`（^0.16.47）；确认 vite 分包与版本锁定。
2. **抽共享核心**：export.ts → export-doc.ts（`buildExportDocument`、EXPORT_CSS、resolveExportImageSrc）；export.ts 改为消费核心，保持 `buildExportHtml`/导出行为零变化（现有测试全过）。
3. **纯函数 + 单测先行**：resolveExportImageSrc、planSegments（含 2x zoom 归一逻辑）。
4. **Vite 多入口**：export-renderer.html + export-renderer.ts 引导骨架（先只回显任务）。
5. **主进程服务**：exporter.cjs（窗口单例/队列/独立 partition + CSP）、exporter-preload.cjs、5 通道与 main.cjs 注册；契约三层贯通。
6. **离屏渲染管线**：注入文档（vars/css/body）、本地 mermaid.initialize+run、katex auto-render、图片 decode 等待、img src 经 resolveExportImageSrc 重写。
7. **Word 路径**：Word 适配（display 公式栅格化、imageResolver 经 read-image 通道、onWarning 收集）→ dom-docx 转换 → done 回传。
8. **长图路径**：measure → zoom=2/dpr 归一（保证跨机 2x 清晰度）→ planSegments → 循环 capture 原语 → canvas 拼接 → PNG bytes → done。
9. **用户入口**：主菜单两项、⋯ 菜单两项、main.ts 分发、浏览器隐藏、进行中/成功/失败 toast、三语文案。
10. **验证**（见下）。
11. **文档同步**。

## 依赖与注意事项

- dom-docx 浏览器子入口 `dom-docx/browser` 仅依赖 docx/cheerio/fflate（Playwright 只在其 Node 入口才需要，不安装）。
- 离屏 partition 用内存型 `session.fromPartition('export-'+随机)` 或固定 `'tmd-exporter'`（不加 persist: 前缀）；专用 CSP 放宽 `img-src` 为 `'self' data: blob: file: https:`、`connect-src 'self' https: data: blob:`，其余保持严格；注册 will-navigate preventDefault。
- 开发模式离屏页 `http://localhost:5173/export-renderer.html`，生产 `dist/export-renderer.html`，与主窗口同一判断逻辑。
- KaTeX：`import 'katex/dist/katex.min.css'`（woff2 字体经 vite 入 dist/assets）；auto-render 用 `katex/dist/contrib/auto-render.mjs`。
- 清晰度归一：隐藏窗口读 deviceScaleRatio，离屏页对文档根设 `zoom = 2 / dpr`（仅长图路径），使输出恒为 2x 物理像素；Word 路径不 zoom（文本矢量，图片由 rasterizeInPlace scale:2 负责）。
- 保存对话框 filters：Word `[{name:'Word', extensions:['docx']}]`，长图 `[{name:'PNG', extensions:['png']}]`；默认名取文档名去 .md 后缀。
- 无 accelerator：不进 SHORTCUT_DEFS（保持 29 项），主菜单两项无快捷键；三语 label 随 setLocaleInfo 重建菜单自动生效。
- 脚注（markdown-it-footnote 输出为 section.footnotes>ol>li，非 dl）先实测 dom-docx 转换效果，内容丢失才加拍平适配器。

## 验证

1. `npx tsc` 0 错误；`npx vitest run` 全过（新增：图片路径解析约 8 例、分段计划约 8 例——单段/整除/余数/zoom 归一/超限拒绝）。
2. `npm run lint`、`prettier --check` 0 问题；`npx vite build` 成功且出现 export-renderer 产物。
3. CDP 桌面实测（隔离 user-data-dir）：
   - **Word**：全语法文档（标题/列表/表格/代码块/引用/高亮/上下标/脚注/内外链图片/Mermaid/KaTeX 行内与独占公式）→ 生成 .docx；解压检查 word/document.xml 含关键文本与表格、word/media 含嵌入图片、Mermaid 与独占公式为位图；文件可被 Word/WPS 打开（结构有效性由 docx 库保证）。
   - **长图**：短文档单段；构造 >4000 CSS px 高文档验证多段拼接接缝连续；PNG 物理宽 = 内容宽×2；深色模式导出背景/代码块跟随深色；相对路径图片可见。
   - 取消保存对话框 → 不离屏渲染、无任务残留；转换失败 toast；浏览器环境两菜单项隐藏。
   - 断网启动离屏任务：Mermaid/KaTeX 正常（本地资源）。
4. `npm run dist:dir` 核对 TMD.app/dmg 体积相对 93.39MB 的增量（预期 <1MB）。

## 风险

- **dom-docx 为新库（1.0.1，0 dependents）**：精确锁版本；仅在离屏页加载且全链路 try/catch，失败只 toast 不影响编辑器；转换器隔离于 src/export-word.ts 单一函数后，替换引擎的改动面 ≤1 个文件；真实文档实测不合格则切换备选方案。
- **超长文档截图内存**：总物理高上限 120000px（约 60000 CSS px，远超常规书籍章节），超限拒绝并 toast；分段单段 ≤8000 物理像素规避纹理上限。
- **隐藏窗口在部分 Linux 无合成器时 capturePage 异常**：捕获失败经 done-error 回传 toast；后续如有报告再评估透明窗口兜底。
- **DPR 差异**：zoom 归一已覆盖；以 NativeImage 实际像素回填断言，不硬编码 2x 中间值。
- **KaTeX 复杂公式在 Word 中走形**：独占公式栅格化保真（不可编辑），行内符号保留可编辑文本；此为 HTML→OOXML 的行业共性限制，在 toast/文档中不特殊打扰用户。

## 实施校准（落地后回填）

1. **Mermaid 不走转换器的 canvas 栅格化**：原计划对 Mermaid 用 dom-docx 的 `rasterizeInPlace`，实测抛错「Tainted canvases may not be exported」——Mermaid SVG 含 foreignObject，画入 canvas 后 `toDataURL` 被判污染。改为与独占公式同一机制：**真实合成器区域截帧**（选择器 `pre.mermaid`，取外层 pre 避免图片困在等宽块里），转换器侧置 `rasterizeInPlace:false`。
2. **清晰度归一语义修正**：原为 `zoom = 2/dpr`（dpr=3 时会下采样降质），落地改为 `zoom = max(1, 2/dpr)`——保证物理清晰度**不低于** 2x，Retina 上不缩放。长图分段计划相应以「实际物理像素比 pixelRatio」为参数（而非 dpr）。
3. **截图原语扩为双模式**：`CaptureRequest` 增加 `region`（不改窗口尺寸只截视口内一块），使公式/图表栅格化与长图分段共用同一条 IPC 通道（通道数仍为 5，未增）。
4. **顺带修复既有缺陷**：markdown-it 的转义规则与上下标插件会二次解释 LaTeX 原文（`\,` 被吞、`x^{2}` 被拆成 `x<sup>{2}</sup>`），原 HTML 导出的公式同样是坏的。新增 `tmd_math` 内联规则整段保留原文，三载体一并修复（新增 6 个单测）。此项超出原计划范围，故回填记录。
5. **验证结果**：桌面端 32 项断言全过（含 docx 解压校验与接缝连续性）；`dist:dir` 后 TMD.app 309M→310M（+1MB 未压缩），dmg 增量更小。
