/**
 * 主进程共享可变状态（应用级 store）。
 *
 * mainWindow / rendererDirty / autosaveEnabled / menuLabels / customShortcuts /
 * sortLocale / shellThemeSource 被多个领域模块（window 生命周期、menu 构建、
 * updater、recent、ipc-files、ipc-app）交叉读写；纯依赖注入需为每个工厂传递
 * 成打成对的 getter/setter，故收敛为本模块——纯 JS 零依赖（可直接单测），
 * 与渲染层 src/store.ts 概念同构。
 *
 * 使用约定：一律经 getter 调用时取值（state.getMenuLabels()），禁止解构快照
 * （const { menuLabels } = ...）——后者拿到的是旧值，状态更新后依旧读旧。
 *
 * @author chiangyang
 */
const { DEFAULT_MENU_LABELS } = require('./menu.cjs')

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null
/** 渲染层未保存脏标记（渲染层经 setDirty IPC 同步） */
let rendererDirty = false
/** 自动保存开关（菜单勾选与设置面板共用，经 IPC 双向同步） */
let autosaveEnabled = false
/** 菜单文案：默认中文兜底，渲染层启动后经 setLocaleInfo IPC 下发当前语言 */
/** @type {Record<string, string>} */
let menuLabels = { ...DEFAULT_MENU_LABELS }
/** 用户自定义快捷键（action → accelerator），渲染层经 syncShortcuts IPC 同步 */
/** @type {Record<string, string>} */
let customShortcuts = {}
/** 文件树排序区域：渲染层同步前先跟随系统语言（空串 = 用 app.getLocale()） */
let sortLocale = ''
/**
 * 壳层主题来源（'system' | 'dark' | 'light'）：启动时从 shell-state.json 恢复，
 * 渲染层切主题时经 IPC 更新。决定窗口底色，原生标题栏深浅由 nativeTheme 驱动
 * @type {'system' | 'dark' | 'light'}
 */
let shellThemeSource = 'system'

/** 窗口底色与渲染层 --bg 变量保持一致，避免启动/切换主题时合成层白底露出 */
const SHELL_BG = { dark: '#1e2127', light: '#ffffff' }

/** 读取主窗口引用（未创建/已销毁时为 null） */
function getMainWindow() {
  return mainWindow
}

/** 设置主窗口引用（createWindow 创建后 / closed 后清 null） */
/** @param {import('electron').BrowserWindow | null} win */
function setMainWindow(win) {
  mainWindow = win
}

/** 渲染层是否有未保存修改 */
function isRendererDirty() {
  return rendererDirty
}

/** 同步渲染层脏标记 */
/** @param {boolean} dirty */
function setRendererDirty(dirty) {
  rendererDirty = !!dirty
}

/** 自动保存开关当前值 */
function isAutosaveEnabled() {
  return autosaveEnabled
}

/** 设置自动保存开关 */
/** @param {boolean} enabled */
function setAutosaveEnabled(enabled) {
  autosaveEnabled = !!enabled
}

/** 当前菜单文案表 */
/** @returns {Record<string, string>} */
function getMenuLabels() {
  return menuLabels
}

/** 替换菜单文案表 */
/** @param {Record<string, string>} labels */
function setMenuLabels(labels) {
  menuLabels = labels
}

/** 用户自定义快捷键表 */
/** @returns {Record<string, string>} */
function getCustomShortcuts() {
  return customShortcuts
}

/** 替换用户自定义快捷键表 */
/** @param {Record<string, string>} shortcuts */
function setCustomShortcuts(shortcuts) {
  customShortcuts = shortcuts
}

/** 文件树排序区域（空串 = 跟随系统语言） */
function getSortLocale() {
  return sortLocale
}

/** 设置文件树排序区域 */
/** @param {string} locale */
function setSortLocale(locale) {
  sortLocale = locale
}

/** 壳层主题来源（'system' | 'dark' | 'light'） */
/** @returns {'system' | 'dark' | 'light'} */
function getShellThemeSource() {
  return shellThemeSource
}

/** 设置壳层主题来源 */
/** @param {'system' | 'dark' | 'light'} source */
function setShellThemeSource(source) {
  shellThemeSource = source
}

module.exports = {
  SHELL_BG,
  getMainWindow,
  setMainWindow,
  isRendererDirty,
  setRendererDirty,
  isAutosaveEnabled,
  setAutosaveEnabled,
  getMenuLabels,
  setMenuLabels,
  getCustomShortcuts,
  setCustomShortcuts,
  getSortLocale,
  setSortLocale,
  getShellThemeSource,
  setShellThemeSource,
}
