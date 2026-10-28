/**
 * Electron 原生能力（preload 注入）的类型与引用
 *
 * 渲染层与壳层之间的唯一契约：编辑器代码只依赖本接口，
 * 不直接接触任何 Electron API，保证壳层可替换（如未来迁移 Tauri）。
 * 浏览器环境下 window.tmdAPI 不存在，各功能模块据此降级。
 *
 * @author chiangyang
 */
import type { PdfOptions } from './pdf-options'

/**
 * 界面语言信息：菜单文案 + 语言码。
 * 主进程据此重建菜单，并把语言码映射为 Intl 排序区域（文件树内中文文件名的
 * 排序规则随界面语言变化，如繁中用注音/笔画序）。
 */
export interface LocaleInfo {
  labels: Record<string, string>
  locale: string
}

/** 文本文件编码（主进程 text-file.cjs 检测结果） */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'
/** 换行风格：保存时按打开文件的多数风格写回 */
export type LineEnding = 'lf' | 'crlf'
/** 打开文件时主进程返回的编码/换行元信息，保存时原样传回 */
export interface TextFileMeta {
  encoding: TextEncoding
  bom: boolean
  lineEnding: LineEnding
}
/** 读取到的文本文档（含保存回写所需的元信息） */
export interface TextFileData extends TextFileMeta {
  path: string
  name: string
  content: string
}

/** AI 服务商预设（由主进程 ai-config.cjs 下发，渲染层不重复维护） */
export interface AiProviderPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 是否必须填写 API Key（Ollama / 自定义本地端点可为 false） */
  needsKey: boolean
}

/** AI 上下文发送范围：三档独立开关，默认只发选区 */
export interface AiContextScope {
  selection: boolean
  document: boolean
  workspace: boolean
}

/** 渲染层可见的 AI 配置：永远不含明文 Key，只能知道是否已保存及其长度 */
export interface AiConfigView {
  enabled: boolean
  provider: string
  baseUrl: string
  model: string
  temperature: number
  streaming: boolean
  context: AiContextScope
  embedModel: string
  hasApiKey: boolean
  /** 已保存 Key 的长度（0 表示未保存；仅长度，供界面渲染占位点） */
  apiKeyLength: number
  providers: AiProviderPreset[]
}

/**
 * AI 配置增量补丁：缺省字段保持原值。
 * apiKey 非空字符串时更新；clearApiKey 为 true 时清除；两者都不传则保留原 Key。
 */
export interface AiConfigPatch {
  enabled?: boolean
  provider?: string
  baseUrl?: string
  model?: string
  temperature?: number
  streaming?: boolean
  context?: Partial<AiContextScope>
  embedModel?: string
  apiKey?: string
  clearApiKey?: boolean
}

/** 连通性测试结果（失败不抛错，直接给结构化错误码与耗时） */
export interface AiTestResult {
  ok: boolean
  code?: string
  message?: string
  latencyMs: number
}

/** 对话消息（角色白名单由主进程校验） */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 主进程推送的流式事件：用 requestId 关联到具体请求 */
export type AiStreamEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'reasoning'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; code: string; message: string }

/** 发起对话的返回值：ok 为 false 时带结构化错误 */
export interface AiChatStart {
  ok: boolean
  requestId?: string
  error?: { code: string; message: string }
}

/** 向量嵌入的返回值：ok 为 false 时带结构化错误（渲染层据此回退关键词检索） */
export type AiEmbedResult =
  { ok: true; vectors: number[][] } | { ok: false; error: { code: string; message: string } }

/** 离线 HTML 导出资源（主进程从 dist/export-assets 读取并内联字体） */
export interface ExportAssets {
  mermaidJs: string
  katexJs: string
  katexAutoRenderJs: string
  katexCss: string
}

/**
 * 壳层能力声明：某些通道只在特定壳里实现（当前 Tauri 版没有图床与自动更新）。
 *
 * 字段缺省 = 支持（Electron preload 不声明本对象，历史行为不变）；
 * 显式 false 表示该能力整块不可用，渲染层据此降级 UI 而不是等调用后拿到
 * undefined。Tauri 的 shim 里未实现通道是 no-op（返回 undefined），
 * 若不做前置探测，`getPicGoConfig()` 之类会在解构结果时直接抛错。
 */
export interface NativeCapabilities {
  /** 图床（PicGo）：uploadImage / getPicGoConfig / savePicGoConfig */
  picgo?: boolean
  /** 自动更新：checkForUpdates / downloadUpdate / installUpdate 等 */
  updater?: boolean
}

/**
 * 壳层是否具备某项能力。
 *
 * 浏览器模式（无 native）与壳层未声明的字段都按「支持」处理——
 * 前者各模块本就有 `!native` 降级分支，后者保证 Electron 版零行为变化。
 */
export function hasNativeFeature(feature: keyof NativeCapabilities): boolean {
  if (!native) return false
  return native.capabilities?.[feature] !== false
}

export interface NativeFileAPI {
  isNative: true
  /** 壳层能力声明（可选；缺省表示全部支持，见 NativeCapabilities） */
  capabilities?: NativeCapabilities
  openFile(): Promise<TextFileData | null>
  readFile(filePath: string): Promise<TextFileData>
  readDir(
    dirPath: string,
  ): Promise<{ path: string; name: string; children: import('./filetree').FileEntry[] } | null>
  openFolder(): Promise<string | null>
  saveFile(filePath: string, content: string, meta?: TextFileMeta): Promise<boolean>
  saveFileAs(
    content: string,
    defaultName?: string,
    meta?: TextFileMeta,
  ): Promise<{ path: string; name: string } | null>
  exportAs(options: {
    content: string
    defaultName: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<{ path: string; name: string } | null>
  /** 离线 HTML 导出资源；资源缺失返回 null（调用方回退 CDN） */
  getExportAssets(): Promise<ExportAssets | null>
  print(name?: string, options?: PdfOptions): Promise<boolean>
  /** 向主进程同步未保存状态（用于关闭确认） */
  setDirty(dirty: boolean): void
  onMenu(callback: (action: string) => void): void
  onAutosave(callback: (enabled: boolean) => void): void
  /** 文件关联：Finder 双击 .md / 系统打开方式传入的文件路径 */
  onOpenPath(callback: (filePath: string) => void): void
  /** 把当前语言的菜单栏文案与语言码发给主进程（重建菜单 + 切换文件树排序区域） */
  setLocaleInfo(info: LocaleInfo): void
  /** 渲染层就绪信号：主进程补发排队中的待打开文件 */
  ready(): void
  /** 设置面板同步自动保存开关（保持与菜单勾选一致） */
  setAutosaveEnabled(enabled: boolean): void
  /** 粘贴图片落盘：写入 dir/assets/name，返回实际文件名 */
  saveImage(options: {
    dir: string
    name: string
    base64: string
  }): Promise<{ name: string } | null>
  /** 链接点击：打开外部 http/https 链接（主进程校验协议白名单） */
  openExternal(url: string): Promise<boolean>
  /** 链接点击：系统默认应用打开本地文件（绝对路径），返回错误串（空串为成功） */
  openLocalFile(filePath: string): Promise<string>
  /** 拖入文件换绝对路径（Electron 32+ 移除了 File.path，经 preload webUtils 解析） */
  getPathForFile(file: File): string
  /** Tauri 独有：订阅文件拖放的原生路径（dragDropEnabled 拦截下 HTML5 drop 不携带文件；Electron/浏览器无此通道） */
  onDropPaths?(callback: (paths: string[]) => void): void
  /** Tauri 独有：按路径读取拖入图片（扩展名白名单 + 32MB 上限），供构造 File 复用插入链；非法返回 null */
  readDroppedFile?(filePath: string): Promise<{ name: string; mime: string; base64: string } | null>
  /** 手动触发检查更新（设置面板"检查更新"按钮） */
  checkForUpdates(): Promise<void>
  /** 用户同意后触发下载 */
  downloadUpdate(): void
  /** 安装已下载的更新：macOS 打开 dmg 引导手动安装并退出应用；Windows 重启安装 */
  installUpdate(): void
  /** 「保存并重启」握手：主进程请求保存当前文档（更新重启前的脏文档处置） */
  onSaveRequest(callback: () => void): void
  /** 保存请求处理完毕回报：true=已保存干净（可安全重启），false=失败/被取消 */
  reportSaveResult(ok: boolean): void
  /** 监听主进程推送的更新状态变化 */
  onUpdateStatus(callback: (status: UpdateStatus) => void): void
  /** 同步"启动时自动检查更新"开关给主进程 */
  setAutoCheckUpdate(enabled: boolean): void
  /** 同步主题给主进程：标题栏/窗口底色切换完成后返回，渲染层再切页面使两者视觉同步 */
  setThemeSource(isDark: boolean): Promise<void>
  /** 自绘标题栏（Windows/Linux）：最小化窗口 */
  winMinimize(): void
  /** 自绘标题栏（Windows/Linux）：最大化/还原切换 */
  winMaximizeToggle(): void
  /** 自绘标题栏（Windows/Linux）：关闭窗口（仍走未保存关闭确认流程） */
  winClose(): void
  /** 订阅窗口最大化状态变化（自绘 □/❐ 图标切换用） */
  onWindowMaximize(callback: (isMax: boolean) => void): void
  /** 启动时全量同步最近文件列表给主进程构建「打开最近」子菜单 */
  recentSync(entries: RecentMenuEntry[]): void
  /** 新增/打开文件后通知主进程注册系统最近文档（Jump List / Dock）并置顶菜单 */
  recentAdd(entry: RecentMenuEntry): void
  /** 渲染层清空最近列表后通知主进程清空系统最近文档并重建菜单 */
  recentClear(): void
  /** 渲染层移除单条后通知主进程同步菜单与系统最近文档 */
  recentRemove(path: string): void
  /** 订阅主进程「打开最近」菜单项点击（参数为文件绝对路径） */
  onRecentOpen(callback: (filePath: string) => void): void
  /** 图床上传：把 base64 图片交给主进程用 PicGo 上传，返回图片 URL。
   *  ext 为按图片 MIME 推导的扩展名（如 '.png'），主进程白名单校验后用于临时文件——
   *  PicGo 按扩展名判定 mime，不能由主进程猜。 */
  uploadImage(base64: string, ext: string): Promise<string | null>
  /** 获取 PicGo 当前配置（图床类型及各图床参数） */
  getPicGoConfig(): Promise<PicGoConfig>
  /** 保存 PicGo 配置到 userData 目录 */
  savePicGoConfig(config: PicGoConfig): Promise<boolean>
  /** 同步快捷键配置到主进程，更新菜单 accelerator */
  syncShortcuts(shortcuts: Record<string, string>): void
  /** 跨文件全文搜索：在给定根目录下递归搜索关键词，返回按行汇总的命中列表 */
  searchFiles(roots: string[], query: string): Promise<SearchResult>
  /** 双链索引：扫描工作区全部笔记的 [[..]]，返回节点与逐处解析后的链接边 */
  wikiScan(roots: string[]): Promise<WikiScanResult>
  /** 文件式主题：列出主题目录（~/.tmd/themes）下全部 .css 主题及目录路径 */
  listThemes(): Promise<ThemeFileList>
  /** 文件式主题：按裸文件名读取主题 CSS 内容（主进程做路径穿越校验，失败 null） */
  readTheme(name: string): Promise<string | null>
  /** 文件式主题：系统文件管理器打开主题目录（空目录时创建并写入示例主题） */
  openThemesDir(): Promise<boolean>
  /** 上报渲染层未捕获异常（仅写入本机日志；级别/来源由主进程固定，不接受客户端指定） */
  reportError(entry: import('./error-report').RendererErrorInfo): void
  /** 系统文件管理器打开日志目录（不存在则创建），返回是否成功 */
  openLogsDir(): Promise<boolean>
  /**
   * 本地历史版本：列出某文件的快照清单（最新在前）。
   * 快照由主进程在每次写盘前自动留存，本方法只负责查阅；无历史返回 null。
   */
  listHistory(filePath: string): Promise<FileHistory | null>
  /** 本地历史版本：读取单条快照正文（id 非法或文件缺失返回 null） */
  readHistory(filePath: string, id: string): Promise<HistoryEntry | null>
  /** 外部修改监视：全量同步「已打开文件」路径集合（主进程差量增删 watcher） */
  watchFiles(paths: string[]): void
  /** 订阅外部修改事件（kind: 'change' 内容变化 / 'unlink' 文件被移除） */
  onFileChanged(callback: (info: FileChangeInfo) => void): void
  /** 侧边栏目录监视：全量同步「已加载目录集合」（主进程差量增删 watcher） */
  watchDirs(paths: string[]): void
  /** 订阅目录变化事件（外部增删/改名），回调参数为发生变化的目录绝对路径 */
  onDirsChanged(callback: (dir: string) => void): void
  /** 文件管理：目录下新建 Markdown 文件（自动补 .md；重名/非法名 reject），返回新路径与名称 */
  createFile(dirPath: string, name: string): Promise<{ path: string; name: string }>
  /** 文件管理：目录下新建文件夹（重名/非法名 reject），返回新路径与名称 */
  createDir(dirPath: string, name: string): Promise<{ path: string; name: string }>
  /** 文件管理：同目录内重命名（重名/非法名 reject），返回新路径与名称 */
  renamePath(oldPath: string, name: string): Promise<{ path: string; name: string }>
  /** 文件管理：系统文件管理器中显示该文件/文件夹 */
  revealInFolder(targetPath: string): Promise<boolean>
  /** 文件管理：删除文件/文件夹（移入系统回收站，可恢复；确认由渲染层承担），失败 reject 或返回 false */
  deletePath(targetPath: string): Promise<boolean>
  /**
   * Word / 长图离屏导出：主进程先弹保存框（取消返回 null），
   * 再把任务下发给隐藏导出窗口执行并写入目标文件。
   */
  exportRun(options: {
    task: import('./export-bridge').ExportTask
    defaultName: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<{ path: string; name: string } | null>
  /** AI：读取配置视图（不含明文 Key，只能得知是否已保存） */
  getAiConfig(): Promise<AiConfigView>
  /** AI：保存配置增量并返回最新视图 */
  saveAiConfig(patch: AiConfigPatch): Promise<AiConfigView>
  /** AI：连通性测试（overrides 为尚未保存的表单值） */
  testAiConnection(overrides?: Partial<AiConfigPatch>): Promise<AiTestResult>
  /** AI：发起流式对话（立即返回，增量事件经 onAiStream 推送） */
  chatAi(requestId: string, messages: AiChatMessage[]): Promise<AiChatStart>
  /** AI：中止在途请求，返回是否命中 */
  abortAi(requestId: string): Promise<boolean>
  /** AI：向量嵌入（工作区检索用，按输入顺序返回） */
  embedAiTexts(texts: string[]): Promise<AiEmbedResult>
  /** AI：订阅流式事件（delta / reasoning / done / error） */
  onAiStream(callback: (event: AiStreamEvent) => void): void
}

/** 最近文件菜单项（渲染层最近列表条目形状，见 store.ts RecentEntry） */
export interface RecentMenuEntry {
  name: string
  path: string
}

/**
 * 全文搜索的单条命中（按「行」汇总，一行最多一条）。
 * `occurrence` 是该行首个匹配在文件内的序号（1 起），
 * 供渲染层在同文档内用 findMatches 重新匹配后精确落位。
 */
export interface SearchMatch {
  /** 文件绝对路径 */
  path: string
  /** 文件名 */
  name: string
  /** 行号（1 起） */
  line: number
  /** 首个匹配的列号（1 起） */
  column: number
  /** 该行首个匹配在文件内的序号（1 起） */
  occurrence: number
  /** 该行原文（超长截断，用于结果预览） */
  text: string
}

/** 全文搜索结果：命中行列表与统计信息 */
export interface SearchResult {
  matches: SearchMatch[]
  /** 命中的文件数 */
  fileCount: number
  /** 实际扫描的文件数 */
  scannedFiles: number
  /** 是否因上限（文件数 / 命中数）而截断 */
  truncated: boolean
  /** 耗时（毫秒） */
  elapsedMs: number
}

/** 双链索引的工作区笔记节点 */
export interface WikiScanNote {
  /** 绝对路径 */
  path: string
  /** 文件名 */
  name: string
}

/** 双链解析结果（主进程按 相对路径→同目录同名→全工作区唯一名 三档解析） */
export type WikiResolvedLink =
  { kind: 'ok'; path: string } | { kind: 'ambiguous'; paths: string[] } | { kind: 'missing' }

/** 双链的单处出现（反向链接面板与图谱共用同一份扫描数据） */
export interface WikiLinkRef {
  /** 链接所在文档绝对路径 */
  source: string
  /** 链接目标原文（[[..]] 内 | 与 # 之前的部分） */
  target: string
  /** 标题锚（[[目标#标题]] 时非空） */
  heading: string
  /** 别名（[[目标|别名]] 时非空） */
  alias: string
  /** 所在行号（1 起） */
  line: number
  /** 所在行原文（超长截断） */
  text: string
  resolved: WikiResolvedLink
}

/** 双链索引扫描结果 */
export interface WikiScanResult {
  notes: WikiScanNote[]
  links: WikiLinkRef[]
  /** 是否因文件数上限而截断 */
  truncated: boolean
}

/** 单条历史快照的元信息（正文按需再取，避免列举时搬运全部内容） */
export interface HistorySnapshot {
  /** 快照 id（本地时间戳串，同时是正文文件名） */
  id: string
  /** 快照产生时刻（ISO 串，渲染层按当前语言本地化展示） */
  ts: string
  /** 正文字节数 */
  size: number
}

/** 某个文件的全部历史快照（最新在前） */
export interface FileHistory {
  /** 源文件绝对路径（以最近一次写入为准，文件改名后仍可对照） */
  path: string
  /** 源文件名 */
  name: string
  snapshots: HistorySnapshot[]
}

/** 单条历史快照的正文 */
export interface HistoryEntry {
  id: string
  ts: string
  content: string
}

/** 外部修改事件（主进程内容指纹比对后推送，自身写入已被过滤） */
export interface FileChangeInfo {
  path: string
  /** change = 内容变化；unlink = 文件被移除 */
  kind: 'change' | 'unlink'
}

/** 文件式主题条目（主题目录中的一个 .css 文件） */
export interface ThemeFileEntry {
  /** 裸文件名（含 .css 扩展名），同时作为持久化标识 */
  name: string
}

/** 主题目录扫描结果 */
export interface ThemeFileList {
  /** 主题目录绝对路径（设置面板提示用） */
  dir: string
  /** 主题条目（已按界面语言区域排序） */
  themes: ThemeFileEntry[]
}

/**
 * PicGo 图床配置：current 为当前选中的图床类型，
 * 各图床参数以扁平对象存储（与 PicGo 的 picBed 配置结构一致）。
 */
export interface PicGoConfig {
  current: string
  [key: string]: unknown
}

/**
 * 更新状态：主进程通过 IPC 推送给渲染层，渲染层据此更新设置面板 UI。
 * 弹窗确认（是否下载 / 下载完成重启）由主进程用原生 dialog 处理。
 */
export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'not-available' }
  | { status: 'downloading'; percent: number }
  /**
   * 下载完成。path 为「手动安装模式」的安装包落盘路径（macOS 下载 dmg 后
   * 提示用户自行拖入「应用程序」）；缺省表示自动安装模式（Windows，走
   * electron-updater） */
  | { status: 'downloaded'; path?: string }
  | { status: 'error'; message: string }

declare global {
  interface Window {
    tmdAPI?: NativeFileAPI
  }
}

/** 当前环境的壳层 API 引用；浏览器环境下为 undefined（各模块据此降级） */
export const native = window.tmdAPI

/**
 * IPC 通道名表：主进程与 preload 共用。
 * 实际常量在 electron/ipc.cjs（JS 模块，Electron 直接 require 无需编译），
 * 该文件用 JSDoc 标注为本接口——tsc checkJs 保证两侧键名对齐，
 * 改通道名时只改这一处。
 */
export interface IpcChannels {
  openFile: string
  readFile: string
  readDir: string
  openFolder: string
  saveFile: string
  saveFileAs: string
  exportAs: string
  exportAssets: string
  print: string
  setDirty: string
  menu: string
  autosave: string
  openPath: string
  setLocaleInfo: string
  ready: string
  setAutosaveEnabled: string
  saveImage: string
  openExternal: string
  openLocalFile: string
  updateCheck: string
  updateStatus: string
  updateDownload: string
  updateInstall: string
  updateAutoCheck: string
  /** 「保存并重启」握手：主进程请求渲染层保存当前文档 */
  docSaveRequest: string
  /** 「保存并重启」握手：渲染层回报保存结果 */
  docSaveResult: string
  setThemeSource: string
  winMinimize: string
  winMaximizeToggle: string
  winClose: string
  winMaxChanged: string
  recentSync: string
  recentAdd: string
  recentClear: string
  recentRemove: string
  recentOpen: string
  uploadImage: string
  getPicGoConfig: string
  savePicGoConfig: string
  syncShortcuts: string
  searchFiles: string
  wikiScan: string
  themesList: string
  themesRead: string
  themesOpenDir: string
  /** 主窗口发起离屏导出任务（弹保存框 + 隐藏窗口执行 + 写文件） */
  exportRun: string
  /** 主进程向离屏导出页下发任务 */
  exporterTask: string
  /** 离屏导出页回传任务结果（字节或错误） */
  exporterDone: string
  /** 离屏导出页原语：设置视口并截图 */
  exporterCapture: string
  /** 离屏导出页原语：白名单读取本地图片为 data URI */
  exporterReadImage: string
  /** 渲染层上报未捕获异常（仅本地落盘，零遥传） */
  logReport: string
  /** 在系统文件管理器中打开日志目录 */
  logOpenDir: string
  /** 本地历史版本：列出某文件的快照清单 */
  historyList: string
  /** 本地历史版本：读取单条快照正文 */
  historyRead: string
  /** 外部修改检测：渲染层全量同步打开文件集合 */
  watchFiles: string
  /** 外部修改检测：主进程推送变化事件 */
  fileChanged: string
  /** 侧边栏目录监视：渲染层全量同步已加载目录集合 */
  watchDirs: string
  /** 侧边栏目录监视：主进程推送目录变化事件 */
  dirsChanged: string
  /** 文件管理：目录下新建 Markdown 文件 */
  createFile: string
  /** 文件管理：目录下新建文件夹 */
  createDir: string
  /** 文件管理：同目录内重命名 */
  renamePath: string
  /** 文件管理：在系统文件管理器中显示 */
  revealInFolder: string
  /** 文件管理：删除文件/文件夹（移入系统回收站） */
  deletePath: string
  /** AI 助手：读取配置视图（不含明文 Key） */
  aiGetConfig: string
  /** AI 助手：保存配置增量 */
  aiSaveConfig: string
  /** AI 助手：连通性测试 */
  aiTest: string
  /** AI 助手：发起流式对话（立即返回，增量事件走 aiStream） */
  aiChat: string
  /** AI 助手：中止在途请求 */
  aiAbort: string
  /** AI 助手：向量嵌入（工作区检索用） */
  aiEmbed: string
  /** AI 助手：主进程推送的流式事件 */
  aiStream: string
}
