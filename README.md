简体中文 | [English](./README-EN.md)

# TMD

**Type Markdown, Done.**

跨平台（macOS / Windows）的 Markdown 所见即所得编辑器，交互对标 Typora，核心特性是 Mermaid 图表的实时渲染。

需求范围见 [docs/需求说明.md](docs/需求说明.md)，架构与模块职责见 [docs/架构设计.md](docs/架构设计.md)，打包发布见 [docs/打包发布.md](docs/打包发布.md)。

## 快速开始

```bash
npm install   # 首次安装依赖（国内网络 Electron 二进制下载失败时见下方说明）
npm run dev            # 浏览器模式：http://localhost:5173
npm run dev:electron   # 桌面模式：同时启动 vite 和 Electron 窗口
npm run build          # 类型检查 + 生产构建
npm run test:desktop   # 桌面端端到端验证（需先 build；真实 Electron + 真实菜单，串行覆盖主链路与导出链路）
npm run bench          # 大文档性能基准（需先 build；MB 级纯文本 / 数十 Mermaid 图 / 图文混排，带回归门禁）
npm run dist:dir       # 打包为本地目录应用（不生成安装包）
npm run dist           # 打包安装包（mac: dmg / win: nsis）
```

> Electron 二进制首次下载失败（GitHub 直连问题）时，改用镜像：
> `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`

## 功能特性

- 所见即所得编辑（Milkdown / ProseMirror 内核 + GFM：表格、任务列表、删除线）
- **Mermaid 实时渲染**（`src/mermaid.ts`，自研插件）：
  - 输入 ` ```mermaid ` 回车即创建图表块
  - 光标在块外：渲染 SVG；点击图表：进入源码编辑；光标离开：重新渲染
  - 输入防抖 400ms；语法错误时清空旧图并显示错误提示（与 Typora/Obsidian 一致）
  - 过期渲染请求丢弃（序号守卫），连续快速输入不闪旧图
- 数学公式（KaTeX：`$...$` 行内 / `$$...$$` 块级实时渲染）
- 代码块语法高亮（`@milkdown/plugin-prism` + refractor，光标进入即编辑源码，与 Typora 一致）
- 多标签页：同路径去重、未保存标记 `•`、每标签滚动位置记忆；标签右键菜单支持关闭当前/其他/左侧/右侧/已保存/全部（批量关闭含未保存内容时整批确认一次）
- 源码模式（CodeMirror 6 整篇编辑，自带搜索面板）
- 查找替换（所见即所得模式下装饰器高亮，支持单个/全部替换）
- 大纲面板（1-3 级标题点击跳转）与目录块（TOC，GitHub 风格锚点）
- 表格编辑：光标入表弹出悬浮工具栏（行/列增删、当前列对齐），列宽拖拽调整
- 快速切换面板（Ctrl/Cmd+P）：模糊搜索已打开标签、已展开的多个文件夹与最近文件，回车直达
- **跨文件全文搜索**（Ctrl/Cmd+Shift+F）：在侧边栏已挂载的文件夹中逐行检索，结果按文件分组显示行号与上下文（关键词高亮），↑↓ 选择、回车打开并定位到匹配处；自动跳过依赖目录、限制单文件大小与结果数量，大型工作区也不会卡住界面
- 文件侧边栏：可同时挂载多个文件夹（独立展开、重启恢复、展开懒加载）与最近打开列表；两者均支持行内 hover × 单条移除与一键清空（二次确认；文件夹只取消挂载，不删除磁盘文件）
- 侧边栏与编辑区之间可拖拽调宽（悬停高亮、宽度记忆、双击分隔条复位，窗口收窄时自动钳制）
- 拖拽打开：拖 .md 文件进窗口即打开（新标签），拖图片进文档按粘贴策略插入
- 格式化快捷键与「格式」菜单：标题 1~6（Ctrl/Cmd+1~6）、加粗/斜体（Ctrl/Cmd+B/I）、链接（Ctrl/Cmd+K）、引用、有序/无序列表、代码块，全部可撤销
- **快捷键自定义**：设置面板按「文件 / 导出 / 格式 / 编辑器」四组罗列 31 项快捷键，点击按键框后按下新组合键即可改键；带冲突检测与就地错误提示，支持一键恢复默认（Windows 显示 `Ctrl+Shift+O`，macOS 按苹果规范显示 `⇧⌘O`）
- 语法扩展：脚注 `[^1]`、高亮 `==文本==`、上/下标（`^x^`/`~x~` 与 `^{x}`/`_{x}` 两种写法均识别，保存统一为 Pandoc 单符号风格）、YAML front matter（文档开头 `---` 围栏渲染为键值属性表，点击进 YAML 源码编辑，保存字节级原样写回，导出 HTML/PDF 自动剥离）；快捷键：高亮 Ctrl/Cmd+Shift+H、上标 Ctrl/Cmd+Shift+=、下标 Ctrl/Cmd+Shift+-
- 编辑区右键上下文菜单：剪切/复制/粘贴 + 按选区显隐的格式化项（含移除链接）
- 链接点击跳转：Ctrl/Cmd+点击外部链接跳浏览器、相对路径链接按文档目录解析后用系统应用打开（悬停按住 Mod 键提示可点）
- 粘贴图片三策略：内联 data URL / 文档同目录 `assets/` 落盘 / 上传到图床（内建 PicGo-Core，支持 SM.MS、GitHub、七牛云、又拍云、腾讯云 COS、阿里云 OSS、Imgur 共 7 种；落盘或上传失败自动降级内联，>5MB 忽略）
- HTML 粘贴转换：从网页/Word 复制的富文本自动转 Markdown（白名单清洗 + 协议过滤，标题/列表/表格/代码块等结构保留）
- 相对路径图片按文档所在目录解析显示（文档数据保持相对路径）
- 导出四种格式：HTML（独立文件，Mermaid/KaTeX 走 CDN）、PDF（经系统打印对话框）、**Word**（原生可编辑 .docx：标题/列表/表格/行内格式/超链接均为 Word 原生元素，独占公式与 Mermaid 图以 2x 位图嵌入）、**长图**（单张 PNG，物理清晰度不低于 2x，超长文档自动分段拼接）
- 自动保存（5 秒周期写回，设置面板与菜单共用开关）
- 拼写检查开关（设置面板「编辑器」分类，默认关闭：Chromium 对可编辑内容默认开启且内置词典仅英语，中文内容不受影响，关闭即消除红色波浪线）
- 深色/浅色主题切换（图表原地重渲，不重建编辑器，保住撤销历史/焦点/滚动位置）
- 主题预设（简约白 / 深色 / 羊皮纸 / 护眼绿）、文件式主题（`~/.tmd/themes/*.css`，文件名即主题名，设置面板一键打开目录/刷新加载）与自定义 CSS 注入（即时生效）
- 多语言界面（简体中文 / 繁體中文（台港用词）/ English，跟随系统，设置面板可切换）
- 设置面板分类导航：弹窗加宽为「左侧分类导航 + 右侧内容」双栏（外观 / 排版 / 编辑器 / 文件与图片 / 快捷键 / 系统 / 关于 七类），点击定位、滚动高亮跟随；主题选择为色卡预览；文件菜单「设置…」或 `Cmd/Ctrl+,` 直达
- 设置面板「关于」：软件名、版本（读 package.json）、版权、联系邮箱、主页（GitHub / Gitee），以及本软件与 13 个第三方组件的许可证声明与直达链接（默认折叠，点开展开）
- 自动更新（Gitee / GitHub 双源，发现新版本弹窗询问，不静默下载）
- **本地崩溃捕获与日志（零遥传）**：crashReporter 只把崩溃转储写入 `~/.tmd/crash-dumps`（不上传、无服务端、无崩溃弹窗）；主/渲染进程 JS 异常与渲染器崩溃统一写 `~/.tmd/logs` 本地 JSONL 日志（7 天/10 文件自动滚动），下次启动自动补记上次崩溃；设置面板一键打开日志文件夹（支持 `TMD_HOME_DIR` 重定位目录）
- **本地历史版本**：每次保存前自动留存被覆盖的旧内容到 `~/.tmd/history`（内容未变不重复留档，每文件 50 条 + 全局 200MB 自动清理）；主菜单「文件 → 历史版本…」可列出快照、预览并恢复到编辑器——恢复只改编辑器内容并置脏，是否覆盖磁盘由你显式保存决定
- **左右分屏**：源码与所见即所得并排（悬浮菜单（⋯）里的「分屏」/ `Ctrl/Cmd+Shift+E`），一侧编辑、另一侧只读跟随——点哪一侧即可编辑那一侧（双向实时同步会让 Markdown 往返转换改写你手写的源码，故不做）；两侧滚动近似同步，中间分隔条可拖拽调宽，宽度会记住
- **主链路端到端测试**：真实构建产物 + Chrome DevTools 协议驱动（无额外测试框架），覆盖打开/编辑/脏标记/保存/另存为/历史版本/分屏双向跟随/未保存关闭拦截/异常落盘/渲染器与主进程崩溃恢复，共 25 项断言
- **Electron 桌面壳**（`electron/`）：
  - 自绘标题栏：Windows/Linux 单行工具栏 + `─ □ ✕` 窗口控制，Mac 红绿灯沉浸式；深浅色切换同帧变色
  - 原生打开/保存/另存为对话框，文件菜单快捷键 Cmd/Ctrl+O / S / Shift+S
  - 文件关联（双击 .md 直接打开）+ 单实例锁（已运行时转交现有窗口）
  - 崩溃恢复（文档内容每次变更即写 localStorage 恢复副本；原生崩溃转储与日志落盘 `~/.tmd/`，纯本地零遥传）
  - 渲染层保持纯网页逻辑，Node 能力经 preload 受控暴露（contextIsolation）
  - 浏览器模式自动降级：文件选择用 `<input type=file>`，保存为下载
  - 安装包瘦身：打包时经 afterPack 钩子裁剪 Electron 的非中英文语言包与 WebGL/Vulkan 渲染组件，Windows 安装包约 93MB

## 技术栈

Electron + TypeScript + Vite + Milkdown（ProseMirror） + Mermaid + CodeMirror 6 + KaTeX + refractor + PicGo-Core + dom-docx。

## 目录结构

```
├─ index.html                    页面入口（所见即所得 + 源码模式）
├─ export-renderer.html           离屏导出页（Word / 长图，隐藏窗口加载）
├─ public/
│  └─ boot.js                    首帧引导脚本（主题 / 平台类，防启动白闪）
│
├─ electron/                     Electron 桌面壳（主进程 + preload）
│  ├─ main.cjs                   主进程入口（窗口创建、菜单、IPC、图床上传、自动更新）
│  ├─ exporter.cjs               离屏导出服务（隐藏窗口、串行任务队列、截图与读图原语）
│  ├─ preload.cjs                受控 API 暴露（contextBridge）
│  ├─ ipc.cjs                    IPC 通道名常量（主进程与 preload 共用）
│  └─ 子模块（纯 Node，可独立验证）：
│      ├─ history.cjs            本地历史版本（写盘前快照、指纹去重、两层剪枝）
│      ├─ logger.cjs              本地 JSONL 日志与崩溃转储扫描
│      ├─ search.cjs              全文搜索的扫描与匹配
│      └─ themes.cjs              文件式主题目录扫描与安全校验
│
├─ scripts/                      构建 / 测试 / 打包脚本
│  ├─ trim-runtime.cjs           打包钩子：裁剪 Electron 运行时冗余文件（语言包、WebGL DLL）
│  ├─ desktop-app-check.mjs      主链路 + 可靠性 + 历史版本 + 分屏 桌面 E2E（25 断言）
│  ├─ desktop-export-check.mjs   导出 Word / 长图 桌面 E2E
│  ├─ desktop-bench.mjs          大文档性能基准（打开、输入、滚动、长任务，带回归门禁）
│  └─ lib/
│     └─ desktop-harness.mjs     桌面 E2E 共享驱动（CDP 客户端、隔离启动、进程组回收）
│
├─ src/                          渲染层（Vite 构建产物）
│  ├─ main.ts                    应用启动与全局装配（boot、hooks 注入、快捷键、菜单回调）
│  ├─ editor-core.ts             编辑器枢纽（创建 / 重建 / 源码模式 / 内容取回）
│  ├─ mermaid.ts                 Mermaid 实时渲染插件（核心特性）
│  ├─ tabs.ts                    多标签页状态机
│  ├─ theme-presets.ts           主题预设、文件式主题与自定义 CSS 注入
│  ├─ shortcuts.ts               快捷键配置（定义 / 读写 / 校验 / 显示格式化）
│  ├─ 搜索相关：
│  │  ├─ search.ts               跨文件全文搜索面板（防抖 / 分组渲染 / 跳转定位）
│  │  └─ find.ts                 查找替换（装饰器实现）
│  ├─ 导出相关：
│  │  ├─ export-doc.ts           导出核心（渲染管线 / 样式 / 图片引用分类，四格式共用）
│  │  ├─ export-word.ts          Word 导出（区域截帧栅格化 + OOXML 转换）
│  │  ├─ export-image.ts         长图导出（分段计划 + canvas 拼接）
│  │  └─ export-renderer.ts      离屏导出页引导（渲染管线 + 任务分派）
│  ├─ 编辑器功能：
│  │  ├─ mark-ext.ts             语法扩展（高亮 / 上下标：解析、序列化、输入规则）
│  │  ├─ frontmatter.ts          YAML front matter（属性表 ⇄ 源码双态编辑）
│  │  ├─ paste-image.ts          粘贴图片插件（inline / assets / 图床 三策略）
│  │  ├─ toc.ts                  目录（TOC）块
│  │  ├─ split.ts                左右分屏交互（分隔条拖拽 / 点选可编辑侧 / 滚动近似同步）
│  │  ├─ history.ts              历史版本面板（快照列表 / 预览 / 恢复到编辑器）
│  │  └─ style.css               全部样式（CSS 变量实现深浅主题 + 高亮配色）
│  └─ 工具与基础设施：
│     ├─ fs-path.ts              文件系统路径工具（规范化 / 取目录 / 同一性判断）
│     └─ error-report.ts         渲染层未捕获异常 / Promise rejection 捕获与 IPC 上报
│
└─ docs/                         项目文档
   ├─ 需求说明.md                功能清单与路线图
   ├─ 架构设计.md                模块职责与数据流
   ├─ 详细设计.md                关键模块实现细节
   ├─ 打包发布.md                本地打包与 CI 发布流程
   └─ git-multi-remote.md        双远程仓库（Gitee + GitHub）同步指南
```

> 完整模块职责说明见 [docs/架构设计.md](docs/架构设计.md)。

## 许可证

本软件以 [MIT License](LICENSE) 发布，Copyright (c) 2026 chiangyang。

第三方组件（Electron、Chromium、Node.js、Milkdown、CodeMirror、Markdown-It、Mermaid、KaTeX、Refractor、remark-frontmatter、PicGo-Core、electron-updater、dom-docx）的许可证声明与链接见软件内设置面板「关于」区域。
