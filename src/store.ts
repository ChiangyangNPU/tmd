/**
 * 持久化存储：localStorage 键与读写的统一入口（零运行时依赖）
 *
 * - doc：崩溃恢复副本（每次内容变更写入，与磁盘保存无关）
 * - theme / recent / folders / img / autosave：偏好与开关
 */
import type { ImageStrategy } from './paste-image'

// 注意：electron/main.cjs「放弃修改并关闭」路径硬编码了此键名，改键时须同步
export const DOC_KEY = 'tmd:doc:v1'
export const THEME_KEY = 'tmd:theme'
export const RECENT_KEY = 'tmd:recent'
export const FOLDER_KEY = 'tmd:folders'
export const IMAGE_STRATEGY_KEY = 'tmd:img'
export const AUTOSAVE_KEY = 'tmd:autosave'
export const LOCALE_KEY = 'tmd:lang'
export const AUTO_CHECK_UPDATE_KEY = 'tmd:auto-check-update'
export const THEME_PRESET_KEY = 'tmd:theme-preset'
export const CUSTOM_CSS_KEY = 'tmd:custom-css'
export const SOURCE_LINENOS_KEY = 'tmd:src-linenos'
export const TYPOGRAPHY_KEY = 'tmd:typography'
export const FOCUS_MODE_KEY = 'tmd:focus-mode'
export const TYPEWRITER_MODE_KEY = 'tmd:typewriter-mode'

/** 文档内容写入恢复副本 */
export function saveDoc(markdown: string) {
  localStorage.setItem(DOC_KEY, markdown)
}

/** 读取恢复副本；无则返回 null */
export function loadDoc(): string | null {
  return localStorage.getItem(DOC_KEY)
}

/** 清除恢复副本（保存成功 / 干净退出 / 用户放弃修改） */
export function clearDoc() {
  localStorage.removeItem(DOC_KEY)
}

/** 读取主题偏好（'dark' | 'light'，默认浅色） */
export function getTheme(): 'dark' | 'light' {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
}

/** 持久化主题偏好（isDark 为 true 存 'dark'） */
export function setTheme(isDark: boolean) {
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light')
}

export interface RecentEntry {
  name: string
  path: string
}

/** 最近打开文件列表（最多 8 条，最新在前） */
export function recentList(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** 记录一条最近打开（同路径去重后置顶）；调用方负责刷新侧边栏 UI */
export function pushRecent(path: string, name: string) {
  const list = recentList().filter((r) => r.path !== path)
  list.unshift({ path, name })
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)))
}

/** 清空最近打开列表（菜单「清空最近文件」）；调用方负责刷新 UI 与同步主进程 */
export function clearRecent() {
  localStorage.removeItem(RECENT_KEY)
}

/** 移除单条最近打开（侧边栏 × 按钮）；不存在的路径静默忽略 */
export function removeRecent(path: string) {
  const list = recentList().filter((r) => r.path !== path)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

export interface FolderEntry {
  name: string
  path: string
}

/** 已打开文件夹列表（工作区，按打开顺序排列，仅存路径引用，不含目录树数据） */
export function folderList(): FolderEntry[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDER_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** 追加一个已打开文件夹（同路径去重，已存在则保持原位）；调用方负责刷新侧边栏 UI */
export function pushFolder(path: string, name: string) {
  const list = folderList()
  if (!list.some((f) => f.path === path)) {
    list.push({ path, name })
    localStorage.setItem(FOLDER_KEY, JSON.stringify(list))
  }
}

/** 清空已打开文件夹列表（仅移除侧边栏引用，不删除磁盘文件） */
export function clearFolders() {
  localStorage.removeItem(FOLDER_KEY)
}

/** 移除单个已打开文件夹（侧边栏 × 按钮，不删除磁盘文件）；不存在的路径静默忽略 */
export function removeFolder(path: string) {
  const list = folderList().filter((f) => f.path !== path)
  localStorage.setItem(FOLDER_KEY, JSON.stringify(list))
}

/** 读取图片粘贴策略（'inline' data URL | 'assets' 落盘，默认 inline） */
export function getImageStrategy(): ImageStrategy {
  return localStorage.getItem(IMAGE_STRATEGY_KEY) === 'assets' ? 'assets' : 'inline'
}

/** 持久化图片粘贴策略 */
export function setImageStrategy(strategy: ImageStrategy) {
  localStorage.setItem(IMAGE_STRATEGY_KEY, strategy)
}

/** 自动保存开关是否开启（默认关闭） */
export function getAutosaveEnabled(): boolean {
  return localStorage.getItem(AUTOSAVE_KEY) === 'true'
}

/** 持久化自动保存开关 */
export function setAutosaveEnabled(enabled: boolean) {
  localStorage.setItem(AUTOSAVE_KEY, enabled ? 'true' : 'false')
}

/** 启动时是否自动检查更新（默认关闭） */
export function getAutoCheckUpdate(): boolean {
  return localStorage.getItem(AUTO_CHECK_UPDATE_KEY) === 'true'
}

/** 持久化"启动时自动检查更新"开关 */
export function setAutoCheckUpdate(enabled: boolean) {
  localStorage.setItem(AUTO_CHECK_UPDATE_KEY, enabled ? 'true' : 'false')
}

/** 读取主题预设 id（'default' | 'sepia' | 'green' | 'github'，默认 default） */
export function getThemePreset(): string {
  return localStorage.getItem(THEME_PRESET_KEY) ?? 'default'
}

/** 持久化主题预设 id */
export function setThemePreset(id: string) {
  localStorage.setItem(THEME_PRESET_KEY, id)
}

/** 读取自定义 CSS（未设置返回空串） */
export function getCustomCss(): string {
  return localStorage.getItem(CUSTOM_CSS_KEY) ?? ''
}

/** 持久化自定义 CSS */
export function setCustomCss(css: string) {
  localStorage.setItem(CUSTOM_CSS_KEY, css)
}

/** 源码模式是否显示行号（默认显示；关闭后隐藏行号列与折叠标记） */
export function getSourceLineNumbers(): boolean {
  return localStorage.getItem(SOURCE_LINENOS_KEY) !== 'false'
}

/** 持久化源码模式行号开关 */
export function setSourceLineNumbers(enabled: boolean) {
  localStorage.setItem(SOURCE_LINENOS_KEY, enabled ? 'true' : 'false')
}

/** 排版设置（编辑区外观，各项空值 = 跟随默认） */
export interface Typography {
  /** font-family 值：'' 跟随默认；否则为字体预设栈或用户自定义栈 */
  font: string
  /** 正文字号（px 数字字符串）：'' = 默认 16 */
  fontSize: string
  /** 正文行距：'' = 默认 1.75；否则为如 '1.5' / '2' */
  lineHeight: string
  /** 编辑区宽度（px 数字字符串）：'' = 默认 860；'full' = 全宽 */
  pageWidth: string
  /** 自动换行：'on'（默认，长行软换行）| 'off'（长行横向滚动） */
  wrap: string
}

/** 默认排版配置（全部跟随内置样式） */
export function defaultTypography(): Typography {
  return { font: '', fontSize: '', lineHeight: '', pageWidth: '', wrap: 'on' }
}

/** 读取排版设置（解析失败或字段缺失时逐项回落默认值） */
export function getTypography(): Typography {
  const base = defaultTypography()
  try {
    const raw = JSON.parse(localStorage.getItem(TYPOGRAPHY_KEY) ?? '{}') as Partial<Typography>
    return {
      font: typeof raw.font === 'string' ? raw.font : base.font,
      fontSize: typeof raw.fontSize === 'string' ? raw.fontSize : base.fontSize,
      lineHeight: typeof raw.lineHeight === 'string' ? raw.lineHeight : base.lineHeight,
      pageWidth: typeof raw.pageWidth === 'string' ? raw.pageWidth : base.pageWidth,
      wrap: raw.wrap === 'off' ? 'off' : base.wrap,
    }
  } catch {
    return base
  }
}

/** 持久化排版设置 */
export function setTypography(typography: Typography) {
  localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(typography))
}

/** 专注模式是否开启（当前段落高亮、其余变暗；默认关闭） */
export function getFocusMode(): boolean {
  return localStorage.getItem(FOCUS_MODE_KEY) === 'true'
}

/** 持久化专注模式开关 */
export function setFocusModeStorage(enabled: boolean) {
  localStorage.setItem(FOCUS_MODE_KEY, enabled ? 'true' : 'false')
}

/** 打字机模式是否开启（光标恒处编辑区垂直中央；默认关闭） */
export function getTypewriterMode(): boolean {
  return localStorage.getItem(TYPEWRITER_MODE_KEY) === 'true'
}

/** 持久化打字机模式开关 */
export function setTypewriterModeStorage(enabled: boolean) {
  localStorage.setItem(TYPEWRITER_MODE_KEY, enabled ? 'true' : 'false')
}
