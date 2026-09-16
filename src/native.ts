/**
 * Electron 原生能力（preload 注入）的类型与引用
 *
 * 渲染层与壳层之间的唯一契约：编辑器代码只依赖本接口，
 * 不直接接触任何 Electron API，保证壳层可替换（如未来迁移 Tauri）。
 * 浏览器环境下 window.tmdAPI 不存在，各功能模块据此降级。
 *
 * @author chiangyang
 */

/**
 * 界面语言信息：菜单文案 + 语言码。
 * 主进程据此重建菜单，并把语言码映射为 Intl 排序区域（文件树内中文文件名的
 * 排序规则随界面语言变化，如繁中用注音/笔画序）。
 */
export interface LocaleInfo {
  labels: Record<string, string>
  locale: string
}

export interface NativeFileAPI {
  isNative: true
  openFile(): Promise<{ path: string; name: string; content: string } | null>
  readFile(filePath: string): Promise<{ path: string; name: string; content: string }>
  readDir(
    dirPath: string,
  ): Promise<{ path: string; name: string; children: import('./filetree').FileEntry[] } | null>
  openFolder(): Promise<string | null>
  saveFile(filePath: string, content: string): Promise<boolean>
  saveFileAs(content: string): Promise<{ path: string; name: string } | null>
  exportAs(options: {
    content: string
    defaultName: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<{ path: string; name: string } | null>
  print(): Promise<boolean>
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
  /** 手动触发检查更新（设置面板"检查更新"按钮） */
  checkForUpdates(): Promise<void>
  /** 用户同意后触发下载 */
  downloadUpdate(): void
  /** 安装已下载的更新并重启 */
  installUpdate(): void
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
  /** 图床上传：把 base64 图片交给主进程用 PicGo 上传，返回图片 URL */
  uploadImage(base64: string): Promise<string | null>
  /** 获取 PicGo 当前配置（图床类型及各图床参数） */
  getPicGoConfig(): Promise<PicGoConfig>
  /** 保存 PicGo 配置到 userData 目录 */
  savePicGoConfig(config: PicGoConfig): Promise<boolean>
  /** 同步快捷键配置到主进程，更新菜单 accelerator */
  syncShortcuts(shortcuts: Record<string, string>): void
  /** 跨文件全文搜索：在给定根目录下递归搜索关键词，返回按行汇总的命中列表 */
  searchFiles(roots: string[], query: string): Promise<SearchResult>
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
  | { status: 'downloaded' }
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
}
