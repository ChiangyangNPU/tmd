简体中文 | [English](./README-EN.md)

# TMD

**Type Markdown, Done.**

跨平台（macOS / Windows）的 Markdown 所见即所得编辑器，交互对标 Typora，核心特性是 Mermaid 图表的实时渲染。

需求范围见 [docs/需求说明.md](docs/需求说明.md)，架构与模块职责见 [docs/架构设计.md](docs/架构设计.md)，关键实现细节见 [docs/详细设计.md](docs/详细设计.md)，版本规划见 [docs/路线图.md](docs/路线图.md)，打包发布见 [docs/打包发布.md](docs/打包发布.md)。

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

## 下载安装（普通用户）

从 [GitHub Releases](https://github.com/ChiangyangNPU/tmd/releases/latest) 或 [Gitee Releases](https://gitee.com/chiangyangNPU/tmd/releases/latest) 下载安装包：

- **macOS**：下载 `TMD-x.y.z-arm64.dmg`，打开后把 TMD 拖入「应用程序」
- **Windows**：下载 `TMD-x.y.z-x64-Setup.exe`，双击安装

> **macOS 首次打开被拦？** 从网页下载的安装包首次打开会被 Gatekeeper 拦截（提示「Apple 无法验证"TMD"…」），属正常现象，按 [docs/mac安装后启动报错解决方案.md](docs/mac安装后启动报错解决方案.md) 放行一次即可；通过应用内「检查更新」安装则不会有这一步。

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
- 快速切换面板（Ctrl/Cmd+P）：模糊搜索已打开标签、已展开的多个文件夹与最近文件，回车直达；中文名文件支持**拼音首字母匹配**（如 `xmsm` → 项目说明.md，字典在面板首次打开时懒加载，纯英文场景零开销）
- **命令面板**（Ctrl/Cmd+Shift+A，可在设置中改键）：模糊搜索并执行全部菜单动作（文件 / 导出 / 历史版本 / 设置）、格式化命令与视图切换（源码 / 分屏 / 自动保存）——命令与菜单共用同一批处理函数，中英文关键词均可检索
- **跨文件全文搜索**（Ctrl/Cmd+Shift+F）：在侧边栏已挂载的文件夹中逐行检索，结果按文件分组显示行号与上下文（关键词高亮），↑↓ 选择、回车打开并定位到匹配处；自动跳过依赖目录、限制单文件大小与结果数量，大型工作区也不会卡住界面
- **双链生态**：`[[目标]]` / `[[目标|别名]]` / `[[目标#标题]]` 三件套（所见即所得与源码双模式渲染，未解析目标弱化提示、点击跳转）；**反向链接面板**（Cmd/Ctrl+Shift+B）列出全工作区引用当前笔记的链接；**关系图谱**（canvas + d3-force 力导向，悬停高亮邻居、点击打开）与**局部图谱**（侧边栏当前笔记邻域迷你图，1/2 层）；重命名笔记时自动重写全工作区引用；快捷键均可在设置中改键
- 文件侧边栏：可同时挂载多个文件夹（独立展开、重启恢复、展开懒加载）与最近打开列表；两者均支持行内 hover × 单条移除与一键清空（二次确认；文件夹只取消挂载，不删除磁盘文件）
- **编码与换行兼容**：打开时自动检测 UTF-8（含 BOM）/ UTF-16LE/BE / GBK，保存时按原编码与原换行（LF/CRLF）写回；Windows 仓库不再因换行归一产生整文件 diff，全文搜索 / 双链扫描 / 外部修改监视使用同一解码器
- **侧边栏文件管理**（桌面端）：文件夹根行 hover 出现「＋文 / ＋夹」行内新建（自动补 .md、重名拒绝、新建文件直接打开）；任意行右键菜单支持「新建 / 重命名 / 在系统中显示」——重命名同步更新已打开标签的关联路径，后续保存写回新路径
- 侧边栏与编辑区之间可拖拽调宽（悬停高亮、宽度记忆、双击分隔条复位，窗口收窄时自动钳制）
- 拖拽打开：拖 .md 文件进窗口即打开（新标签），拖图片进文档按粘贴策略插入
- 格式化快捷键与「格式」菜单：标题 1~6（Ctrl/Cmd+1~6）、加粗/斜体（Ctrl/Cmd+B/I）、链接（Ctrl/Cmd+K）、引用、有序/无序列表、代码块，全部可撤销
- **快捷键自定义**：设置面板按「文件 / 导出 / 格式 / 编辑器」四组罗列 34 项快捷键，点击按键框后按下新组合键即可改键；带冲突检测与就地错误提示，支持一键恢复默认（Windows 显示 `Ctrl+Shift+O`，macOS 按苹果规范显示 `⇧⌘O`）
- 语法扩展：脚注 `[^1]`、高亮 `==文本==`、上/下标（`^x^`/`~x~` 与 `^{x}`/`_{x}` 两种写法均识别，保存统一为 Pandoc 单符号风格）、YAML front matter（文档开头 `---` 围栏渲染为键值属性表，点击进 YAML 源码编辑，保存字节级原样写回，导出 HTML/PDF 自动剥离）；快捷键：高亮 Ctrl/Cmd+Shift+H、上标 Ctrl/Cmd+Shift+=、下标 Ctrl/Cmd+Shift+-
- 编辑区右键上下文菜单：剪切/复制/粘贴 + 按选区显隐的格式化项（含移除链接）
- 链接点击跳转：Ctrl/Cmd+点击外部链接跳浏览器、相对路径链接按文档目录解析后用系统应用打开（悬停按住 Mod 键提示可点）
- 粘贴图片三策略：内联 data URL / 文档同目录 `assets/` 落盘 / 上传到图床（内建 PicGo-Core，支持 SM.MS、GitHub、七牛云、又拍云、腾讯云 COS、阿里云 OSS、Imgur 共 7 种；落盘或上传失败自动降级内联，>5MB 忽略）
- HTML 粘贴转换：从网页/Word 复制的富文本自动转 Markdown（白名单清洗 + 协议过滤，标题/列表/表格/代码块等结构保留）
- **TSV 粘贴转表格**：从 Excel/表格软件复制的纯文本（制表符分隔、至少 2 行 × 2 列、列数对齐）粘贴即生成真实表格（首行作表头）；富文本剪贴板仍优先走 HTML 转换管线，普通句子里的单个制表符不会误触
- 相对路径图片按文档所在目录解析显示（文档数据保持相对路径）
- 导出五种格式：HTML（独立文件，Mermaid/KaTeX 走 CDN）、PDF（程序化 printToPDF 生成，设置面板可选纸张 / 方向 / 页边距 / 页眉页脚 / 页码 / 书签）、**Word**（原生可编辑 .docx：标题/列表/表格/行内格式/超链接均为 Word 原生元素，独占公式注入 OMML 可编辑公式，Mermaid 图以 2x 位图嵌入）、**长图**（单张 PNG，物理清晰度不低于 2x，超长文档自动分段拼接）、**LaTeX**（独立可编译 .tex 源码：公式原生透传零失真，中文文档 ctexart 文档类，图片相对路径随文件解析；Mermaid 图表以注释保留源码）
- 自动保存（5 秒周期写回，设置面板与菜单共用开关）
- **选区字数统计**：编辑区选中文字时工具栏实时切「已选 N / 共 M 字」双数字（150ms 合并刷新，拖拽选择不抖动），清除选区还原全文计数
- 拼写检查开关（设置面板「编辑器」分类，默认关闭：Chromium 对可编辑内容默认开启且内置词典仅英语，中文内容不受影响，关闭即消除红色波浪线）
- 深色/浅色主题切换（图表原地重渲，不重建编辑器，保住撤销历史/焦点/滚动位置）
- 主题预设（简约白 / 深色 / 护眼米黄 / 护眼绿 / 液态玻璃 / **液态玻璃 Pro**——SVG 位移折射透镜，浮层边缘呈现苹果 Liquid Glass 式背景弯曲）、文件式主题（`~/.tmd/themes/*.css`，文件名即主题名，设置面板一键打开目录/刷新加载）与自定义 CSS 注入（即时生效）；预设外观首帧即生效（构建期静态注入 + boot.js 属性恢复，无启动闪变）
- 多语言界面（简体中文 / 繁體中文（台港用词）/ English，跟随系统，设置面板可切换）
- 设置面板分类导航：弹窗加宽为「左侧分类导航 + 右侧内容」双栏（外观 / 排版 / 编辑器 / 文件与图片 / 快捷键 / 系统 / 关于 七类），点击定位、滚动高亮跟随；主题选择为色卡预览；文件菜单「设置…」或 `Cmd/Ctrl+,` 直达
- **Ctrl/Cmd+滚轮缩放字号**：编辑区内逐级 ±1px（12–28 钳制），触控板捏合同效；底部 HUD 原地刷新数值，经排版设置持久化，所见即所得与源码模式同步变化
- **排版设置**：字体 12 预设（默认/宋/黑/楷/等宽写作/仿宋/霞鹜文楷/思源宋体/Times/Charter/Segoe 雅黑/Helvetica，跨平台回退栈），选中类别后可从栈内具体字体中**二级择主**；字号 / 行距 / 编辑区宽度 / 自动换行全部即时生效并持久化
- **窗口记忆**：窗口尺寸 / 位置 / 最大化状态持久化，重启原样恢复（显示器拔插时自动回落默认摆放）
- 设置面板「关于」：软件名、版本（读 package.json）、版权、联系邮箱、主页（GitHub / Gitee），以及本软件与 15 个第三方组件的许可证声明与直达链接（默认折叠，点开展开）
- 自动更新（Gitee / GitHub 双源，发现新版本弹窗询问，不静默下载）
- **本地崩溃捕获与日志（零遥传）**：crashReporter 只把崩溃转储写入 `~/.tmd/crash-dumps`（不上传、无服务端、无崩溃弹窗）；主/渲染进程 JS 异常与渲染器崩溃统一写 `~/.tmd/logs` 本地 JSONL 日志（7 天/10 文件自动滚动），下次启动自动补记上次崩溃；设置面板一键打开日志文件夹（支持 `TMD_HOME_DIR` 重定位目录）
- **本地历史版本**：每次保存前自动留存被覆盖的旧内容到 `~/.tmd/history`（内容未变不重复留档，每文件 50 条 + 全局 200MB 自动清理）；主菜单「文件 → 历史版本…」可列出快照、预览并恢复到编辑器——恢复只改编辑器内容并置脏，是否覆盖磁盘由你显式保存决定
- **外部修改检测与重载**：打开的文件在磁盘上被其他程序（编辑器 / git / 网盘）修改时自动感知——干净标签静默重载（内容未变不弹提示）；脏标签绝不静默覆盖，顶部提示条二选一：「重新加载」（采用磁盘内容并清脏）或「保留我的版本」（磁盘再变会再次提示）；文件被外部删除时提示且编辑器内容保留。内容指纹（sha1）过滤自身写入，不会误报；关闭标签即撤监视
- **左右分屏**：源码与所见即所得并排（悬浮菜单（⋯）里的「分屏」/ `Ctrl/Cmd+Shift+E`），一侧编辑、另一侧只读跟随——点哪一侧即可编辑那一侧（双向实时同步会让 Markdown 往返转换改写你手写的源码，故不做）；两侧滚动近似同步，中间分隔条可拖拽调宽，宽度会记住
- **主链路端到端测试**：真实构建产物 + Chrome DevTools 协议驱动（无额外测试框架），覆盖打开/编辑/脏标记/保存/另存为/外部修改检测（自动重载与脏态二选一）/历史版本/分屏双向跟随/未保存关闭拦截/异常落盘/渲染器与主进程崩溃恢复，共 49 项断言
- **Electron 桌面壳**（`electron/`）：
  - 自绘标题栏：Windows/Linux 单行工具栏 + `─ □ ✕` 窗口控制，Mac 红绿灯沉浸式；深浅色切换同帧变色
  - 原生打开/保存/另存为对话框，文件菜单快捷键 Cmd/Ctrl+O / S / Shift+S
  - 文件关联（双击 .md 直接打开）+ 单实例锁（已运行时转交现有窗口）
  - 崩溃恢复（文档内容每次变更即写 localStorage 恢复副本；原生崩溃转储与日志落盘 `~/.tmd/`，纯本地零遥传）
  - 渲染层保持纯网页逻辑，Node 能力经 preload 受控暴露（contextIsolation）
  - 浏览器模式自动降级：文件选择用 `<input type=file>`，保存为下载
  - 安装包瘦身：打包时经 afterPack 钩子裁剪 Electron 的非中英文语言包与 WebGL/Vulkan 渲染组件，Windows 安装包约 93MB

## 技术栈

Electron + TypeScript + Vite + Milkdown（ProseMirror） + Mermaid + CodeMirror 6 + KaTeX + refractor + markdown-it（含 footnote / mark / sub / sup 插件） + PicGo-Core + dom-docx + mathml2omml + d3-force + remark-frontmatter + pinyin-pro + fflate。

## 目录结构

```
├─ index.html                    页面入口（所见即所得 + 源码模式）
├─ export-renderer.html           离屏导出页（Word / 长图，隐藏窗口加载）
├─ public/
│  └─ boot.js                    首帧引导脚本（主题 / 平台类，防启动白闪）
│
├─ electron/                     Electron 桌面壳（主进程 + preload）
│  ├─ main.cjs                   主进程入口（窗口 / 菜单生命周期、文件关联、各领域模块装配）
│  ├─ app-state.cjs              跨模块共享状态 store（主窗口 / 脏标记 / 菜单文案 / 主题来源，纯 JS 可单测）
│  ├─ updater.cjs                自动更新（Gitee / GitHub 双源、macOS dmg 自行下载安装）
│  ├─ shell-state.cjs            壳层状态持久化（主题来源 + 窗口几何，随 userData 清理）
│  ├─ recent.cjs                 最近文件镜像 + 系统最近文档注册（Jump List / Dock 菜单）
│  ├─ ipc-files.cjs              文件 / 目录 / 搜索 / 双链 / 主题 / 日志 / 历史 / 导出 / 打印 IPC
│  ├─ ipc-app.cjs                应用级 IPC（状态同步 / 窗口控制 / 图片落盘 / 链接跳转）
│  ├─ picgo.cjs                  图床上传（PicGo-Core 实例懒加载 + 配置读写）
│  ├─ menu.cjs                   应用菜单模板工厂（纯数据工厂，零 Electron 依赖，可独立单测）
│  ├─ exporter.cjs               离屏导出服务（隐藏窗口、串行任务队列、截图与读图原语）
│  ├─ preload.cjs                受控 API 暴露（contextBridge）
│  ├─ exporter-preload.cjs       离屏导出页专用桥接（最小权限：4 个方法）
│  ├─ ipc.cjs                    IPC 通道名常量（主进程与 preload 共用）
│  └─ 子模块（纯 Node，可独立验证）：
│     ├─ history.cjs              本地历史版本（写盘前快照、指纹去重、两层剪枝）
│     ├─ logger.cjs               本地 JSONL 日志与崩溃转储扫描
│     ├─ search.cjs               全文搜索的扫描与匹配
│     ├─ wikilinks.cjs            双链索引扫描与解析（复用 search 枚举 + 围栏跳过）
│     ├─ filewatcher.cjs          打开文件的外部修改监视（内容指纹过滤自身写入）
│     ├─ fsops.cjs                侧边栏文件管理纯函数（新建 / 重命名的名称与路径安全）
│     └─ themes.cjs               文件式主题目录扫描与安全校验
│
├─ scripts/                      构建 / 测试 / 打包脚本
│  ├─ trim-runtime.cjs           打包钩子：裁剪 Electron 运行时冗余文件（语言包、WebGL DLL）
│  ├─ gen-lens-map.mjs           生成液态玻璃 Pro 的折射位移图（PNG data URI，改参数重跑后替换常量）
│  ├─ make-icon.mjs              由 build/icon.svg 一键重建 png / icns / ico 图标
│  ├─ make-dmg-background.mjs    生成 dmg 安装窗口背景图（当前版本号画进背景）
│  ├─ patch-mac-dmg.mjs          dmg 后处理：转 ULMO 压缩 + 更新清单 sha512/size 重算
│  ├─ extract-release-notes.mjs  从 CHANGELOG 提取当前版本说明写入 .release-notes.md
│  ├─ prepare-gitee-release.mjs  生成 / 重算 Gitee 自动更新清单与待上传清单
│  ├─ cleanup-old-app.sh         清理本地旧应用构建
│  ├─ desktop-app-check.mjs      主链路 + 可靠性 + 外部修改检测 + 历史版本 + 分屏 + 查找映射 桌面 E2E（49 断言）
│  ├─ desktop-export-check.mjs   导出 Word / 长图 / LaTeX 桌面 E2E（36 断言）
│  ├─ desktop-bench.mjs          大文档性能基准（打开、输入、滚动、长任务，带回归门禁）
│  ├─ *-probe.mjs / ime-*.mjs    一次性真机诊断探针（输入法 / 双链 / 图谱对齐 / 思维导图 / 脏标记 / 输入剖析）
│  └─ lib/
│     └─ desktop-harness.mjs     桌面 E2E 共享驱动（CDP 客户端、隔离启动、进程组回收）
│
├─ src/                          渲染层（Vite 构建产物）
│  ├─ main.ts                    应用启动与全局装配（boot、hooks 注入、快捷键、菜单回调）
│  ├─ editor-core.ts             编辑器枢纽（创建 / 重建 / 源码模式 / 内容取回）
│  ├─ tabs.ts                    多标签页状态机（含每标签滚动位置）
│  ├─ files.ts                   文件操作（打开 / 保存、多文件夹工作区、最近列表）
│  ├─ filetree.ts                文件树 / 最近文件 / 已打开文件夹渲染（任意层级按需展开）
│  ├─ store.ts                   localStorage 键与读写统一入口
│  ├─ native.ts                  壳层契约接口（NativeFileAPI，浏览器模式自动降级）
│  ├─ autosave.ts                自动保存（5 秒写回定时器）
│  ├─ settings.ts                设置面板装配（语言 / 主题 / CSS / 图床 / 快捷键 / 更新 / 关于）
│  ├─ shortcuts.ts               快捷键配置（定义 / 读写 / 校验 / 显示格式化，单一数据源）
│  ├─ i18n.ts                    多语言运行时（语言包加载 / t() / DOM 批量替换）
│  ├─ theme.ts                   深浅模式切换（图表原地重渲，不重建编辑器）
│  ├─ theme-presets.ts           主题预设、文件式主题与自定义 CSS 注入
│  ├─ theme-preset-css.ts        预设 CSS 单一来源（内置预设 + 液态玻璃 Pro 滤镜，运行时注入与首帧静态注入共用）
│  ├─ mermaid.ts                 Mermaid 实时渲染插件（核心特性）
│  ├─ sourcemode.ts              CodeMirror 6 源码模式
│  ├─ split.ts                   左右分屏交互（分隔条拖拽 / 点选可编辑侧 / 滚动近似同步）
│  ├─ writing-modes.ts           专注模式 / 打字机模式
│  ├─ typography.ts              排版设置（字体 / 字号 / 行距 / 宽度 / 自动换行 → CSS 变量）
│  ├─ font-zoom.ts               Ctrl/Cmd+滚轮缩放字号
│  ├─ outline.ts                 大纲面板（1-3 级标题点击跳转）
│  ├─ command-palette.ts         命令面板（Ctrl/Cmd+Shift+A，模糊搜索并执行菜单动作）
│  ├─ quick-switch.ts            快速切换面板（Ctrl+P 模糊搜索）
│  ├─ pinyin-index.ts            拼音首字母索引（中文文件名匹配，懒加载）
│  ├─ 搜索：
│  │  ├─ search.ts               跨文件全文搜索面板（防抖 / 分组渲染 / 跳转定位）
│  │  ├─ find.ts                 查找替换（装饰器实现）
│  │  └─ findbar.ts              查找栏 DOM 装配（源码模式交给 CodeMirror 自带面板）
│  ├─ 双链与图谱：
│  │  ├─ wikilink.ts             双链语法内核（[[目标]] / 别名 / 标题锚 + 未解析装饰）
│  │  ├─ wikilink-index.ts       双链索引渲染层缓存（按需扫描 / 失效调度 / 三档解析）
│  │  ├─ backlinks.ts            反向链接面板（按来源分组，点击定位）
│  │  ├─ link-rewrite.ts         改名自动重写全工作区引用
│  │  ├─ graph.ts                关系图谱（canvas + d3-force，设置弹层）
│  │  └─ local-graph.ts          局部图谱侧边栏面板（当前笔记邻域，1/2 层）
│  ├─ 导出：
│  │  ├─ export.ts               导出动作层（HTML / PDF / Word / 长图 / LaTeX）
│  │  ├─ export-doc.ts           载体无关的导出文档核心（解析管线 / 样式 / 图片引用分类，五载体共用）
│  │  ├─ export-latex.ts         LaTeX 适配器（token 流 → 可编译 .tex）
│  │  ├─ export-word.ts          Word 导出（区域截帧栅格化 + OOXML 转换）
│  │  ├─ export-omml.ts          Word 公式可编辑化（LaTeX → MathML → OMML 后处理）
│  │  ├─ export-image.ts         长图导出（分段计划 + canvas 拼接）
│  │  ├─ export-renderer.ts      离屏导出页引导（渲染管线 + 任务分派）
│  │  └─ export-bridge.ts        离屏页与主进程 exporter 的桥接契约
│  ├─ 编辑器功能：
│  │  ├─ mark-ext.ts             语法扩展（高亮 / 上下标 / 脚注：解析、序列化、输入规则）
│  │  ├─ frontmatter.ts          YAML front matter（属性表 ⇄ 源码双态编辑）
│  │  ├─ paste-image.ts          粘贴图片插件（inline / assets / 图床 三策略）
│  │  ├─ paste-html.ts           HTML 粘贴转换（白名单清洗 → schema 解析）
│  │  ├─ paste-tsv.ts            TSV 粘贴转表格
│  │  ├─ table-input.ts          Typora 式表格输入（管道行 + 回车即时成表）
│  │  ├─ table-toolbar.ts        表格悬浮工具栏（行列增删 / 对齐 / 删除整表）
│  │  ├─ table-markdown.ts       表格 Markdown 规范化（空单元格占位清理）
│  │  ├─ text-escaping.ts        文本转义补丁（恢复表格单元格内标点转义）
│  │  ├─ image-attrs.ts          图片缩放 / 对齐（拖拽改宽 + 对齐浮层）
│  │  ├─ image-resolver.ts       文档内相对路径图片按文档目录解析
│  │  ├─ task-list.ts            任务列表复选框点击切换
│  │  ├─ toc.ts                  目录（TOC）块
│  │  ├─ context-menu.ts         编辑区右键上下文菜单
│  │  ├─ tab-menu.ts             标签栏右键菜单（关闭当前/其他/左右侧/已保存/全部）
│  │  ├─ link-nav.ts             链接点击跳转（Mod+点击，外部/本地分发）
│  │  ├─ format.ts               格式化命令层（配置驱动，可撤销标准事务）
│  │  └─ dragdrop.ts             拖拽打开文件（.md/.txt）与拖入图片
│  ├─ 面板与基础设施：
│  │  ├─ history.ts              历史版本面板（快照列表 / 预览 / 恢复到编辑器）
│  │  ├─ external-change.ts      外部修改检测与重载提示条
│  │  ├─ error-report.ts         渲染层未捕获异常 / Promise rejection 捕获与 IPC 上报
│  │  └─ fs-path.ts              文件系统路径工具（规范化 / 取目录 / 同一性判断）
│  ├─ *.d.ts                     类型声明（katex-auto-render / markdown-it-plugins / vite-env）
│  ├─ locales/                   语言包（zh-CN / zh-Hant / en）
│  ├─ templates/                 index.html 浮层 / 面板 HTML 分块（?raw 内联）
│  ├─ styles/                    样式分块（01 设计令牌 → 15 打印，编号即级联顺序）
│  ├─ style.css                  样式入口：仅按原级联顺序 @import styles/*.css
│  └─ __tests__/                 vitest 纯函数单元测试（56 个测试文件 / 697 用例）
│
├─ docs/                         项目文档
│  ├─ 需求说明.md                功能清单与路线图
│  ├─ 架构设计.md                模块职责与数据流
│  ├─ 详细设计.md                关键模块实现细节
│  ├─ 路线图.md                  版本规划与能力差距分析
│  ├─ 打包发布.md                本地打包与 CI 发布流程
│  ├─ mac安装后启动报错解决方案.md  Gatekeeper 拦截放行说明
│  ├─ git-multi-remote.md        双远程仓库（Gitee + GitHub）同步指南
│  └─ archive/                   历史开发计划归档（非现行文档，仅供追溯）
│
├─ build/                        打包资源（图标、dmg 背景图、NSIS 自定义脚本）
├─ .github/workflows/            CI（build / release 工作流）
├─ dist/                         渲染层构建产物（vite build 输出；本地生成，git 忽略，可随时删除重建）
├─ release/                      本地打包产物（electron-builder 输出：dmg / nsis 安装包与应用目录；本地生成，git 忽略，可随时删除）
└─ releases/                     自动更新清单（latest.yml / latest-mac.yml，git 跟踪）：Gitee 更新源指向本目录
                                 的 raw 地址，electron-updater 据此发现新版本并校验安装包 sha512；每次发版后
                                 由 CI / 本地发布脚本重新生成并提交——勿手改、勿删除，删掉 Gitee 渠道自动更新即失效
```

> 完整模块职责说明见 [docs/架构设计.md](docs/架构设计.md)。

## 许可证

本软件以 [MIT License](LICENSE) 发布，Copyright (c) 2026 chiangyang。

第三方组件（Electron、Chromium、Node.js、Milkdown、CodeMirror、Markdown-It、Mermaid、KaTeX、Refractor、remark-frontmatter、PicGo-Core、electron-updater、dom-docx、mathml2omml、fflate）的许可证声明与链接见软件内设置面板「关于」区域。
