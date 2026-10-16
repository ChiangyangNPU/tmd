/**
 * 应用级 IPC（主进程侧）。
 *
 * 覆盖：渲染层状态同步（脏标记 / 自动保存 / 主题 / 快捷键 / 语言）、自绘窗口
 * 控制按钮、粘贴图片落盘、外部链接与本地文件跳转、渲染层就绪信号。
 *
 * 依赖注入（ipcMain/nativeTheme/shell 由 main.cjs 传入，菜单重建与待打开文件
 * 冲刷等回调亦由 main.cjs 注入）而非顶层 require('electron')：本模块可被
 * 单测直接 require（与 exporter.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const { DEFAULT_MENU_LABELS } = require('./menu.cjs')
const state = require('./app-state.cjs')

/**
 * 界面语言码 → Intl 排序区域。文件树里中文文件名按当前界面语言排序：
 * 繁中必须落到 zh-TW 才会走注音/笔画序（zh-Hant 不在 ICU 的排序区域表里，
 * 用它会退回默认中文序，与系统预期不符）；未知语言码原样透传。
 * @type {Record<string, string>}
 */
const COLLATION_LOCALE = { 'zh-CN': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en' }

/**
 * 外部链接协议白名单：仅放行 http/https/mailto，防任意协议（file:/javascript: 等）
 * 注入系统打开器。渲染层 IPC（openExternal）与主窗口 setWindowOpenHandler 共用。
 * @param {unknown} url
 * @returns {boolean}
 */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * 注册应用级 IPC。
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   nativeTheme: import('electron').NativeTheme,
 *   shell: import('electron').Shell,
 *   IPC: typeof import('./ipc.cjs'),
 *   saveShellState: (patch: Record<string, unknown>) => void,
 *   rebuildMenu: () => void,
 *   flushPendingOpenPaths: () => void,
 *   getAutosaveMenuItem: () => import('electron').MenuItem | null,
 * }} deps
 */
function registerAppIpc({
  ipcMain,
  nativeTheme,
  shell,
  IPC,
  saveShellState,
  rebuildMenu,
  flushPendingOpenPaths,
  getAutosaveMenuItem,
}) {
  // 渲染层同步未保存状态
  /** @param {unknown} _event @param {unknown} dirty */
  ipcMain.on(IPC.setDirty, (_event, dirty) => {
    state.setRendererDirty(!!dirty)
  })

  // 设置面板同步自动保存开关（保持菜单勾选状态一致）
  /** @param {unknown} _event @param {unknown} enabled */
  ipcMain.on(IPC.setAutosaveEnabled, (_event, enabled) => {
    state.setAutosaveEnabled(!!enabled)
    const item = getAutosaveMenuItem()
    if (item) item.checked = state.isAutosaveEnabled()
  })

  // 渲染层主题同步：nativeTheme.themeSource 设置系统深浅色偏好，
  // 渲染层 prefers-color-scheme 随动（两平台标题栏均已自绘/隐藏，随之一起变色）。
  // 同步切换窗口底色（合成层颜色），消除切换瞬间内容区的白底闪烁；
  // 持久化到 shell-state.json，下次启动在窗口创建前恢复。
  // 用 handle + invoke：壳层切换完成后才返回，渲染层随后再翻页面，两者视觉同步
  ipcMain.handle(IPC.setThemeSource, (_event, isDark) => {
    const source = isDark ? 'dark' : 'light'
    state.setShellThemeSource(source)
    nativeTheme.themeSource = source
    state
      .getMainWindow()
      ?.setBackgroundColor(source === 'dark' ? state.SHELL_BG.dark : state.SHELL_BG.light)
    saveShellState({ themeSource: source })
  })

  // 自绘标题栏窗口控制（Windows/Linux 工具栏右侧 ─ □ ✕；Mac 无此 UI）。
  // close() 走统一 close 流程：有未保存修改仍会先弹原生确认对话框
  ipcMain.on(IPC.winMinimize, () => state.getMainWindow()?.minimize())
  ipcMain.on(IPC.winMaximizeToggle, () => {
    const win = state.getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.winClose, () => state.getMainWindow()?.close())

  // 粘贴图片落盘：写入文档同目录 assets/ 文件夹（base64 解码后写入）。
  // 入参做白名单校验（与 themes.cjs 的「IPC 入参不可信」口径对齐）：name 必须
  // 是非隐藏裸文件名（path.basename 校验拒绝路径分隔与 .. 穿越），非法时抛错
  // ——调用方（paste-image）catch 后降级为内联图片
  /** @param {unknown} _event @param {unknown} options */
  ipcMain.handle(IPC.saveImage, async (_event, options) => {
    const opts = /** @type {{ dir?: unknown, name?: unknown, base64?: unknown }} */ (options)
    const dir = typeof opts?.dir === 'string' ? opts.dir : ''
    const name = typeof opts?.name === 'string' ? opts.name : ''
    const base64 = typeof opts?.base64 === 'string' ? opts.base64 : ''
    if (!dir || !base64 || !name || path.basename(name) !== name || name.startsWith('.')) {
      throw new Error('saveImage: 非法入参')
    }
    const assetsDir = path.join(dir, 'assets')
    await fs.mkdir(assetsDir, { recursive: true })
    const filePath = path.join(assetsDir, name)
    await fs.writeFile(filePath, Buffer.from(base64, 'base64'))
    return { name }
  })

  /** @param {unknown} _event @param {unknown} url */
  ipcMain.handle(IPC.openExternal, (_event, url) => {
    if (!isSafeExternalUrl(url)) return false
    return shell.openExternal(url).then(
      () => true,
      () => false,
    )
  })

  // 本地文件：交给系统默认应用打开（路径由渲染层按当前文档目录解析为绝对路径）
  /** @param {unknown} _event @param {unknown} filePath */
  ipcMain.handle(IPC.openLocalFile, (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return 'invalid path'
    return shell.openPath(filePath)
  })

  // 渲染层同步快捷键配置，更新菜单 accelerator
  ipcMain.on(IPC.syncShortcuts, (_event, shortcuts) => {
    if (shortcuts && typeof shortcuts === 'object') {
      state.setCustomShortcuts(/** @type {Record<string, string>} */ (shortcuts))
      rebuildMenu()
    }
  })

  // 渲染层就绪：补发排队中的待打开文件
  ipcMain.on(IPC.ready, () => {
    flushPendingOpenPaths()
  })

  // 渲染层把当前语言的菜单文案与语言码发来：重建菜单 + 更新文件树排序区域
  /** @param {unknown} _event @param {{ labels?: Record<string, string>, locale?: string }} info */
  ipcMain.on(IPC.setLocaleInfo, (_event, info) => {
    if (info?.labels) {
      state.setMenuLabels({ ...DEFAULT_MENU_LABELS, ...info.labels })
      rebuildMenu()
    }
    if (info?.locale) state.setSortLocale(COLLATION_LOCALE[info.locale] ?? info.locale)
  })
}

module.exports = { registerAppIpc, isSafeExternalUrl }
