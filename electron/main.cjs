/**
 * TMD Electron 主进程
 *
 * 职责：创建窗口、应用菜单（文件操作/导出快捷键）、通过 IPC 提供文件与目录读写。
 * 渲染层保持纯网页逻辑，所有 Node 能力都经由 preload 暴露的受控 API 访问。
 *
 * 模块结构：
 * - 窗口与菜单生命周期（createWindow / buildMenu，「打开最近文件」子菜单由渲染层列表同步）
 * - 文件与目录 IPC（open-file / read-file / read-dir / save-* / export-as / print）
 * - 文件关联（open-file 事件 + 单实例锁，双击 .md 直接在本应用打开）
 * - 系统最近文档（app.addRecentDocument / clearRecentDocuments：Windows Jump List、macOS Dock 菜单）
 *
 * 类型：本文件为 JS，经 JSDoc 标注参与 tsc checkJs 检查；
 * IPC 通道名统一取自 ./ipc.cjs（与 src/native.ts 的 IpcChannels 对齐）。
 *
 * @author chiangyang
 */
const {
  app,
  BrowserWindow,
  Menu,
  crashReporter,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  collectSearchFiles,
  searchInFiles,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES,
} = require('./search.cjs')
const {
  listThemeFiles,
  readThemeFile,
  ensureThemesDirWithSample,
} = require('./themes.cjs')
const { createFileWatcher } = require('./filewatcher.cjs')
const { sanitizeFileName, childPath, ensureMarkdownExt } = require('./fsops.cjs')
const { createExporter } = require('./exporter.cjs')
const {
  tmdHome,
  logsDir,
  crashDumpsDir,
  createLogger,
  normalizeRendererReport,
  scanNewDumps,
} = require('./logger.cjs')
const { historyDir, writeSnapshot, listSnapshots, readSnapshot } = require('./history.cjs')
// 应用菜单模板：纯数据工厂（零 Electron 依赖，独立单测），状态与副作用注入见 buildMenu
const { DEFAULT_MENU_LABELS, buildMenuTemplate } = require('./menu.cjs')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const IPC = require('./ipc.cjs')
// 图床上传：PicGo-Core（仅 Node 环境可用，故放在主进程）
const { PicGo } = require('picgo')
// 自动更新：electron-updater。开发模式（app.isPackaged === false）下
// checkForUpdates 会因找不到 latest.yml 报错，统一由 error 事件处理。
const { autoUpdater } = require('electron-updater')

// 双更新源：Gitee（国内默认）+ GitHub（国外备用）。Gitee 失败时自动切换 GitHub 重试一次。
// 注意：Gitee raw 有 CDN 缓存（约 5 分钟）。不在此处用查询参数 ?t=xxx 绕过——
// electron-updater 的 generic provider 会把 url 与 latest.yml 拼接，
// 加查询参数会变成 .../releases/?t=xxx/latest.yml 导致 404，故直接接受缓存延迟。
// 分支名必须是 master：Gitee 仓库默认分支不是 main，写成 main 会 404（元数据也写在
// master 上，见 CI 工作流的 contents API 与 docs/打包发布.md §7.2）。
/** @type {import('builder-util-runtime').GenericServerOptions} */
const GITEE_SOURCE = {
  provider: 'generic',
  url: 'https://gitee.com/chiangyangNPU/tmd/raw/master/releases/',
}
/** @type {import('builder-util-runtime').GithubOptions} */
const GITHUB_SOURCE = {
  provider: 'github',
  owner: 'ChiangyangNPU',
  repo: 'tmd',
}

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

// ---------- 崩溃捕获与本地日志（零遥传） ----------
// crashReporter 必须在 app ready 之前启动：crashpad 捕获原生崩溃后把 minidump
// 写入 ~/.tmd/crash-dumps。uploadToServer:false 且不设 submitURL——只落盘、绝不上传，
// 尊重开源无遥传原则。TMD_HOME_DIR 可重定位资产根目录（E2E 隔离 / 便携版）。
const tmdRoot = tmdHome()
// 崩溃目录重定位到 ~/.tmd/crash-dumps：Electron 44 已移除 start 的
// crashesDirectory 选项，正式做法是 ready 前 app.setPath('crashDumps', dir)
const crashDumpDir = crashDumpsDir(tmdRoot)
fsSync.mkdirSync(crashDumpDir, { recursive: true })
app.setPath('crashDumps', crashDumpDir)
crashReporter.start({
  // uploadToServer:false ——崩溃报告只收集进崩溃目录，绝不上传
  uploadToServer: false,
  compress: true,
})
const logger = createLogger({ home: tmdRoot })

// ---------- 本地历史版本（文件快照） ----------
// 根目录 ~/.tmd/history：每次写盘覆盖前把被覆盖的旧内容存档，仅提供人工恢复
// 入口（不自动回滚）。与 themes / logs 同级、跨升级保留，随 TMD_HOME_DIR 重定位。
const historyRoot = historyDir(tmdRoot)

/**
 * 写盘前的历史快照：读取即将被覆盖的旧内容存入历史目录。
 * 快照是纯附加能力，任何失败（文件首次创建、权限、磁盘）都必须静默，
 * 绝不能反过来阻断用户的保存动作；去重与剪枝由 history.cjs 内部处理。
 * @param {string} filePath
 */
async function snapshotBeforeWrite(filePath) {
  try {
    const previous = await fs.readFile(filePath, 'utf-8')
    await writeSnapshot(historyRoot, {
      path: filePath,
      name: path.basename(filePath),
      content: previous,
    })
  } catch {
    /* 文件尚不存在（首次保存）或读取失败：无旧内容可存 */
  }
}

// ---------- 外部修改检测（打开文件的磁盘监视） ----------
// 渲染层把「已打开文件路径集合」全量同步过来（开关标签 / 另存为后），
// 这里差量挂 fs.watch；内容真变化时经 IPC 推给渲染层分流（干净自动重载 /
// 脏态弹条二选一）。指纹过滤保证自身保存不会误报。
const fileWatcher = createFileWatcher({
  onEvent: (info) => sendToRenderer(IPC.fileChanged, info),
})

// 主进程 JS 异常：落盘后保持 Electron 默认语义（不主动退出），仅补本地记录。
// 注意写盘失败已在 logger 内部静默，不会递归进入本钩子。
process.on('uncaughtException', (err) => {
  logger.log(
    'error',
    'main',
    err instanceof Error ? err.message : String(err),
    err instanceof Error ? err.stack : undefined,
  )
})
process.on('unhandledRejection', (reason) => {
  logger.log(
    'error',
    'main',
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  )
})

// 子进程（渲染器 / GPU / utility）消失事件：离屏导出窗口在 exporter.cjs 另有
// 自身的任务 reject 与窗口重建处理，此处负责主窗口等其余进程的崩溃留痕。
app.on('child-process-gone', (_event, details) => {
  logger.logChildProcessGone(details)
})

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null

// 壳层主题状态（'system' | 'dark' | 'light'）：启动时从 shell-state.json 恢复，
// 渲染层切主题时经 IPC 更新。决定窗口底色，原生标题栏深浅由 nativeTheme 驱动
/** @type {'system' | 'dark' | 'light'} */
let shellThemeSource = 'system'
/** 窗口底色与渲染层 --bg 变量保持一致，避免启动/切换主题时合成层白底露出 */
const SHELL_BG = { dark: '#1e2127', light: '#ffffff' }
/** @type {import('electron').MenuItem | null} */
let autosaveMenuItem = null
let rendererDirty = false
let autosaveEnabled = false

// ---------- 最近文件（镜像渲染层 localStorage 列表，权威仍在渲染层） ----------
/** 最近文件（最新在前，与渲染层 tmd:recent 同序同长，渲染层经 IPC 同步） */
/** @type {import('../src/native.ts').RecentMenuEntry[]} */
let recentDocs = []

/**
 * 把任意输入收窄为合法的最近文件条目数组（去重、限量 8）。
 * IPC 入参不可信：非字符串/空路径一律丢弃。
 * @param {unknown} raw
 * @returns {import('../src/native.ts').RecentMenuEntry[]}
 */
function normalizeRecent(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {import('../src/native.ts').RecentMenuEntry[]} */
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { path: p, name } = /** @type {{path?: unknown, name?: unknown}} */ (item)
    if (typeof p !== 'string' || !p || typeof name !== 'string' || !name) continue
    if (seen.has(p)) continue
    seen.add(p)
    out.push({ path: p, name })
    if (out.length >= 8) break
  }
  return out
}

// ---------- 自动更新状态 ----------
/** @type {'gitee' | 'github'} */
let currentUpdateSource = 'gitee'
/** 启动时是否自动检查更新（由渲染层经 updateAutoCheck IPC 同步，默认 false） */
let autoCheckUpdateEnabled = false
/** 最近一次更新检查是否来自用户手动触发（菜单）；自动检查置 false */
let updateCheckManual = false
/** 最近一次 update-available 的元数据（macOS 手动下载 dmg 时取下载地址用） */
/** @type {import('electron-updater').UpdateInfo | null} */
let lastUpdateInfo = null
/** macOS 已下载并校验通过的 dmg 落盘路径（「打开安装包」用） */
/** @type {string | null} */
let downloadedInstallerPath = null
/** 是否已因出错切换过源（避免 error 事件中无限切换重试） */
let updateSourceSwitched = false

// 菜单文案：默认中文（默认表在 menu.cjs），渲染层启动后把当前语言的文案经 IPC 发来并重建菜单
/** @type {Record<string, string>} */
let menuLabels = { ...DEFAULT_MENU_LABELS }

/**
 * 界面语言码 → Intl 排序区域。文件树里中文文件名按当前界面语言排序：
 * 繁中必须落到 zh-TW 才会走注音/笔画序（zh-Hant 不在 ICU 的排序区域表里，
 * 用它会退回默认中文序，与系统预期不符）；未知语言码原样透传。
 * @type {Record<string, string>}
 */
const COLLATION_LOCALE = { 'zh-CN': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en' }
/** 文件树排序区域：渲染层同步前先跟随系统语言 */
let sortLocale = ''

/**
 * 用户自定义快捷键配置：action → Electron accelerator。
 * 由渲染层通过 syncShortcuts IPC 同步过来，buildMenu 据此动态设置菜单 accelerator。
 * 空对象表示全部使用默认值（在 buildMenu 中硬编码的 accelerator）。
 * @type {Record<string, string>}
 */
let customShortcuts = {}

// 文件关联：Finder 双击 .md 时 macOS 通过 open-file 事件传入路径；
// 渲染层未就绪时先排队，收到 ready 信号后再发给渲染层
/** @type {string[]} */
const pendingOpenPaths = []

/** @param {string} channel @param {unknown} [payload] */
function sendToRenderer(channel, payload) {
  // 只发主窗口：兜底取 getAllWindows()[0] 可能选中隐藏的离屏导出窗口——
  // 它没有对应的渲染层 handler，消息只会静默丢失；主窗口不在时干脆不发
  mainWindow?.webContents.send(channel, payload)
}

/**
 * 清除渲染层 localStorage 的恢复副本（关闭确认的「放弃修改并关闭」与更新重启
 * 的「放弃修改并重启」共用）。用户明确放弃修改：绕过渲染层 beforeunload，需在
 * 主进程直接清除，否则下次启动会"复活"被放弃的内容（与"放弃修改"语义冲突）。
 * 注意：此键名与渲染层 src/store.ts 的 DOC_KEY 一致，改键名时须同步。
 * 渲染层卡死（非崩溃）时 executeJavaScript 永不返回——3s 兜底后放弃清除
 * （副本多留一份的代价小于流程卡死）。
 */
async function clearRendererRecoveryCopy() {
  try {
    await Promise.race([
      mainWindow?.webContents.executeJavaScript(
        "localStorage.removeItem('tmd:doc:v1')",
      ),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch (err) {
    console.warn('[tmd] 清除恢复副本失败', err)
  }
}

/** @param {string} filePath */
function queueOpenPath(filePath) {
  pendingOpenPaths.push(filePath)
  // ready 前不能建窗口（macOS 经文件关联启动时 open-file 早于 ready 到达）：
  // 路径已在队列里，whenReady → createWindow → did-finish-load 会补发，
  // 这里提前 createWindow 只会抛 "Cannot create BrowserWindow before app is ready"
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 应用在后台无窗口（上次窗口已全部关闭）：重建窗口承载打开的文件，
    // did-finish-load 后补发；并把应用带到前台（Finder 双击的用户预期）
    createWindow()
    app.focus({ steal: true })
    return
  }
  flushPendingOpenPaths()
}

/** 把排队中的待打开文件发给渲染层，并把窗口带到前台 */
function flushPendingOpenPaths() {
  while (pendingOpenPaths.length) {
    sendToRenderer(IPC.openPath, pendingOpenPaths.shift())
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    app.focus({ steal: true })
  }
}

/**
 * 对话框父窗口：优先主窗口；主窗口已关而离屏导出窗口尚存时，不得把隐藏的
 * 导出窗口当父窗（原生对话框会挂在不可见窗口上，用户完全看不到）——
 * 选可见窗口兜底；可见窗口也没有时（理论不可达：触发对话框的 IPC 均来自
 * 主窗口渲染层）返回 undefined 交给 dialog 以无父窗模式弹出。
 * @returns {import('electron').BrowserWindow | undefined}
 */
function dialogParent() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const windows = BrowserWindow.getAllWindows()
  return windows.find((w) => w.isVisible()) ?? undefined
}

// 对话框包装：dialogParent() 可能无可用父窗（主窗口已关、仅剩不可见的离屏
// 导出窗口），此时以无父窗模式弹出——dialog 的类型要求父窗非空，经这里分流
/** @param {import('electron').MessageBoxOptions} options */
function showMessageBoxSafe(options) {
  const parent = dialogParent()
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

/** @param {import('electron').OpenDialogOptions} options */
function showOpenDialogSafe(options) {
  const parent = dialogParent()
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

/** @param {import('electron').SaveDialogOptions} options */
function showSaveDialogSafe(options) {
  const parent = dialogParent()
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
}

// 离屏导出服务（Word / 长图）：隐藏窗口单例 + 串行队列，编排逻辑在离屏页
const exporter = createExporter({
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  IPC,
  rendererUrl: DEV_SERVER_URL,
  getParentWindow: () => mainWindow,
})

/**
 * 构建（并设置）应用菜单。
 *
 * 菜单文案取自渲染层下发的语言包（menuLabels），渲染层未就绪时用中文兜底；
 * 各菜单项的 accelerator 优先使用用户自定义快捷键（customShortcuts），
 * 未自定义时回落到内置默认值。渲染层切换语言或改动快捷键后会再次调用本函数重建。
 */
function buildMenu() {
  // 模板构建抽至 menu.cjs（纯数据工厂，可独立单测）；本函数只注入状态与副作用：
  // - labels/shortcuts/recents/autosaveEnabled 为 main.cjs 持有的可变状态快照
  // - 三个回调把「动作分发 / 最近文件打开 / 自动保存开关」反转回主进程 IPC
  const template = buildMenuTemplate({
    labels: menuLabels,
    shortcuts: customShortcuts,
    recents: recentDocs,
    autosaveEnabled,
    isMac: process.platform === 'darwin',
    onAction: (action) => sendToRenderer(IPC.menu, action),
    onRecentOpen: (path) => sendToRenderer(IPC.recentOpen, path),
    onAutosaveToggle: (enabled) => {
      autosaveEnabled = enabled
      sendToRenderer(IPC.autosave, enabled)
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  autosaveMenuItem = Menu.getApplicationMenu()?.getMenuItemById('autosave') ?? null
}

/** 主窗口 CSP 是否已注入：createWindow 可能被多次调用（macOS 关窗后重新激活），
 *  webRequest 监听器重复注册会叠加，故只注入一次 */
let mainCspRegistered = false

/**
 * 注入主窗口 CSP：阻断渲染层加载非预期外部资源（防 XSS）。
 * script-src 'self'：禁止 eval/内联脚本；style-src 含 'unsafe-inline'
 * 是因为 Mermaid/KatTeX 生成的 SVG style 标签与 ProseMirror 装饰器依赖内联样式；
 * img-src 含 data: blob: 支持粘贴图片的内联 data URL 与文件树图标。
 */
function ensureMainCsp() {
  if (mainCspRegistered) return
  mainCspRegistered = true
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
        ],
      },
    })
  })
}

/**
 * 创建主窗口。
 *
 * 流程：先注入 CSP 响应头（阻断渲染层加载非预期外部资源，防 XSS），
 * 再按当前主题设置窗口底色，并按平台选择标题栏样式——macOS 红绿灯沉浸、
 * Windows/Linux 完全自绘，最后加载渲染层入口。
 *
 * 窗口以隐藏创建，等 ready-to-show（渲染层首帧绘制完成）再上屏：首帧由
 * boot.js 预挂 html.dark / data-theme-preset，本来就是主题外观；若创建即
 * 显示，窗口底色只兜深浅两态，主题预设（纸黄/护眼绿/玻璃等）不落
 * shell-state，必先闪一帧系统底色再切到选中主题。
 */
function createWindow() {
  ensureMainCsp()

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'TMD',
    // 窗口底色跟随主题：ready-to-show 前窗口不可见，此底色仅作兜底
    // （如加载失败页），保证任何情况下露出的都是当前深浅色的底
    backgroundColor: shellThemeSource === 'dark' ? SHELL_BG.dark : SHELL_BG.light,
    show: false,
    // Mac：隐藏标题栏文字，红绿灯浮在自定义工具栏上（Typora 式沉浸）
    // trafficLightPosition：hiddenInset 的默认垂直位置偏低，按 44px 工具栏手工居中
    // Windows/Linux：完全自绘标题栏（工具栏右侧 ─ □ ✕ 按钮）——原生标题栏由
    // DWM 独立绘制，主题切换无法与内容区同一帧变化；自绘后标题区属于页面，
    // 一次重绘全部同步。双击工具栏拖拽区仍由系统处理最大化/还原
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarStyle: 'hidden' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require 本地 ./ipc.cjs（IPC 通道名常量），沙箱化
      // preload 无法加载本地模块。渲染层仍无 Node 权限，安全边界不变。
      sandbox: false,
    },
  })

  // Windows/Linux：隐藏原生菜单栏（Mac 的应用菜单在屏幕顶部系统菜单栏，
  // 窗口内本就不显示），使窗口只留自定义工具栏一行，跨平台观感统一。
  // 仅隐藏显示，菜单对象仍在，其绑定的快捷键（Ctrl+O/Ctrl+S/Ctrl+P 等）不受影响。
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false)
  }

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 首帧就绪再上屏：ready-to-show 正常先于 did-finish-load 触发；
  // did-finish-load 兜底（重复 show 幂等，以可见性判定防双重触发）
  const win = mainWindow
  const showWhenPainted = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', showWhenPainted)
  win.webContents.once('did-finish-load', showWhenPainted)

  // 窗口加载完成后，把排队中的待打开文件发给渲染层
  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingOpenPaths()
  })

  // 兜底阻止页面导航：拖文件进窗口时 Chromium 默认会导航到该文件，
  // 渲染层 drop 处理器已 preventDefault，这里拦截漏网情况（应用为单页，无合法导航）
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // window.open（正文链接 Shift+点击 / 中键等 Chromium 默认行为，link-nav 只拦
  // Mod+点击）会创建继承本窗口 webPreferences 的新窗口：远程页面将持有完整
  // preload，tmdAPI 的任意路径读写对它完全可用。一律拒绝 window.open，
  // http(s)/mailto 链接转交系统浏览器（复用 openExternal 的协议白名单，
  // 与 exporter.cjs 离屏窗口的 deny 口径一致）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  // 渲染进程消失（崩溃 / 被杀 / OOM）：这是渲染器维度的权威事件。
  // app 级 child-process-gone 主要覆盖 GPU / utility，forcefullyCrashRenderer 等
  // 场景只触发本事件；details 无 type 字段，补 'renderer' 与日志函数入参形状对齐。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.logChildProcessGone({ type: 'renderer', ...details })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 最大化状态推送：渲染层据此切换自绘按钮的 □/❐ 图标
  const pushMaximized = () => sendToRenderer(IPC.winMaxChanged, mainWindow?.isMaximized() === true)
  mainWindow.on('maximize', pushMaximized)
  mainWindow.on('unmaximize', pushMaximized)

  // 未保存关闭确认：渲染层通过 IPC 同步脏标记，这里用原生对话框拦截关闭。
  // 不能在渲染层用 window.confirm —— Electron 关闭流程中它不可靠，会导致窗口无法关闭。
  // closingDialogOpen：对话框弹出期间再点自绘 ✕ 会再次触发 close——不做防重入
  // 会叠出多个对话框，且各自回调交错执行 destroy 与 rendererDirty 复位
  let closingDialogOpen = false
  mainWindow.on('close', (event) => {
    if (!rendererDirty || closingDialogOpen) return
    if (!mainWindow) return
    closingDialogOpen = true
    event.preventDefault()
    // 本处理器挂在 mainWindow 的 close 事件上，彼时窗口必然存活
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        message: '有未保存的修改',
        detail: '关闭前会丢失未保存的内容。',
        buttons: ['放弃修改并关闭', '取消'],
        // 破坏性动作不做默认按钮：回车/空格落在这个按钮上会直接丢弃内容，
        // 与数据安全惯例相反，默认落在「取消」上
        defaultId: 1,
        cancelId: 1,
      })
      .then(async ({ response }) => {
        closingDialogOpen = false
        if (response !== 0) return
        rendererDirty = false
        await clearRendererRecoveryCopy()
        mainWindow?.destroy()
      })
      .catch((err) => {
        // 对话框本身失败（极少见）：复位防重入，让用户能再次发起关闭
        closingDialogOpen = false
        console.warn('[tmd] 关闭确认对话框失败', err)
      })
  })
}

// ---------- 自动更新 ----------

/**
 * 设置当前更新源并重置切换标记。
 * @param {'gitee' | 'github'} source
 */
function setUpdateSource(source) {
  currentUpdateSource = source
  autoUpdater.setFeedURL(source === 'gitee' ? GITEE_SOURCE : GITHUB_SOURCE)
  // 切换源后允许出错时再切换到另一个源
  updateSourceSwitched = false
}

/**
 * 请求渲染层保存当前文档并等待结果回报（「保存并重启」的握手）。
 * 不设超时：另存为对话框开多久都得等——超时后重启会把未写完的文档留在半路；
 * 悬挂的代价只是更新不立即安装（autoInstallOnAppQuit 在下次退出时兜底）。
 * 同一时刻至多一个待决保存请求（弹窗本身模态），先清旧监听防叠加。
 * @returns {Promise<boolean>} true=已保存干净（脏标记已清），false=失败/被取消/渲染层无响应
 */
function requestRendererSave() {
  return new Promise((resolve) => {
    ipcMain.removeAllListeners(IPC.docSaveResult)
    ipcMain.once(IPC.docSaveResult, (_event, ok) => resolve(ok === true))
    sendToRenderer(IPC.docSaveRequest)
  })
}

/**
 * 安装已下载的更新——update-downloaded 弹窗与设置面板「立即重启」共用入口。
 * 文档干净：确认后 quitAndInstall（Squirrel 退出时从暂存 zip 原子替换
 * /Applications/TMD.app 并重启，全程无需用户动手）。
 * 有未保存修改：不落入窗口 close 拦截的通用「放弃修改并关闭/取消」确认
 * （语义不对且叠在更新流程上），改为三选——保存并重启 / 放弃修改并重启 /
 * 稍后。「稍后」不退出，由 autoInstallOnAppQuit 在下次退出时自动安装。
 */
async function installDownloadedUpdate() {
  // 主窗口已不在（渲染层进程随之消失）：无脏数据可言，直接走干净重启
  if (!mainWindow || !rendererDirty) {
    const { response } = await showMessageBoxSafe({
      type: 'info',
      title: 'TMD',
      message: '下载完成，重启以安装',
      detail: '应用将关闭并安装更新后重新启动。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
    return
  }
  try {
    const { response } = await showMessageBoxSafe({
      type: 'warning',
      title: 'TMD',
      message: '下载完成，重启以安装',
      detail: '有未保存的修改，重启前需要先处理。',
      // 默认落在「保存并重启」：数据安全优先
      buttons: ['保存并重启', '放弃修改并重启', '稍后'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 2) return
    if (response === 1) {
      // 放弃修改并重启：与关闭确认的「放弃修改并关闭」同语义——先清恢复副本，
      // 再销毁窗口绕过 beforeunload 的挂起序列化回写，防止被放弃的内容
      // 以恢复副本"复活"；窗口没了之后再走更新重启（Squirrel 不依赖窗口）
      rendererDirty = false
      await clearRendererRecoveryCopy()
      mainWindow?.destroy()
      autoUpdater.quitAndInstall()
      return
    }
    // 保存并重启：saveDocument 成功后渲染层会先同步 setDirty(false)
    // 再回报结果，quitAndInstall 走 close 拦截时 rendererDirty 已是 false
    const saved = await requestRendererSave()
    if (saved) {
      autoUpdater.quitAndInstall()
      return
    }
    // 保存失败/被另存为取消（渲染层已 toast 过失败原因）：留在应用内由用户处理
    showMessageBoxSafe({
      type: 'info',
      title: 'TMD',
      message: '暂不重启',
      detail: '文档未能保存，应用没有重启。已下载的更新会在下次退出时自动安装。',
      buttons: ['确定'],
      defaultId: 0,
    }).catch(() => {})
  } catch (err) {
    // 对话框本身失败（极少见）：停在原地，更新留给下次退出自动安装
    console.warn('[tmd] 更新重启流程中断', err)
  }
}

// ---------- macOS：自行下载 dmg + 引导手动安装 ----------
// 为什么不走 autoUpdater.downloadUpdate()：那条路的安装环节交给 Squirrel.Mac，
// 实测在 macOS 26 + electron-updater 6.8.9 下两轮复现失败——electron-updater
// 下载完成后经本地代理把包交给 Squirrel，Squirrel 侧却始终零连接、ShipIt 暂存
// 目录为空、无任何错误上报，「立即重启」也只是静默挂号，更新永远装不上。故
// macOS 只用 electron-updater 做版本检查，安装包由这里自行下载，引导用户手动
// 拖入「应用程序」。

/**
 * 校验安装包 sha512 与元数据一致。
 * electron-updater 的 downloadUpdate 本会校验元数据里的 sha512，自行下载必须
 * 补上——否则传输截断或被篡改时无从察觉。
 * @param {string} filePath
 * @param {string | undefined} expectedBase64 元数据里的 sha512；缺省时跳过（老格式兜底）
 * @returns {Promise<void>}
 */
async function verifySha512(filePath, expectedBase64) {
  if (!expectedBase64) return
  const hash = createHash('sha512')
  // 流式读盘而非一次性读入：安装包 ~85MB，避免把整包塞进主进程堆
  /** @type {Promise<void>} */
  const digested = new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  await digested
  if (hash.digest('base64') !== expectedBase64) {
    await fs.unlink(filePath).catch(() => {})
    throw new Error('安装包校验失败（sha512 不匹配），文件已删除，请重试')
  }
}

/**
 * 清除下载隔离标记（com.apple.quarantine）。
 * Chromium 的下载栈会给落盘文件打上该标记，用户拖进「应用程序」的 app 会
 * 继承它；本项目为 ad-hoc 签名（build.mac.identity = "-"，不使用开发者证书、
 * 裁剪语言包后与实际内容不符），会被判「已损坏，无法打开」。dmg 由我们自己
 * 下载、且已通过 sha512 校验（来源可信），故主动清除标记，让用户装完直接
 * 双击即可使用。
 *
 * 文件本就没有该标记时 xattr 会返回非零，属正常情况，静默忽略。
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function clearQuarantine(filePath) {
  return new Promise((resolve) => {
    execFile('xattr', ['-d', 'com.apple.quarantine', filePath], () => resolve())
  })
}

/**
 * 下载 URL 到指定目录，返回落盘绝对路径。
 * 走 session.downloadURL + will-download，复用 Electron 自身的下载栈
 * （自动处理重定向），并借 updated 事件回推进度。
 * @param {string} url
 * @param {string} destDir
 * @returns {Promise<string>}
 */
function downloadToFile(url, destDir) {
  return new Promise((resolve, reject) => {
    const ses = mainWindow?.webContents.session ?? session.defaultSession
    let started = false
    const timer = setTimeout(() => {
      if (started) return
      ses.removeListener('will-download', onWillDownload)
      reject(new Error('下载未启动（10 秒内未收到下载响应）'))
    }, 10000)

    // 目标文件名：Gitee 附件地址会 302，最终地址不带原路径，按文件名兜底匹配
    const expectName = new URL(url).pathname.split('/').pop()

    /**
     * @param {import('electron').Event} _event
     * @param {import('electron').DownloadItem} item
     */
    function onWillDownload(_event, item) {
      // 只认本次发起的下载（同一会话同一时刻可能还有其他下载在进行）。
      // Gitee 附件地址会 302 到带令牌的最终地址（foruda.gitee.com/...?token=...），
      // will-download 时 item.getURL() 已是最终地址、与发起 URL 不再相等
      // （发起地址保留在 getURLChain 里）——实测 v0.1.3 发布当日即因严格相等
      // 匹配失败而误报「下载未启动」。匹配口径放宽：URL 或重定向链上任一
      // 与发起一致，或文件名与目标一致
      const chain = item.getURLChain ? item.getURLChain() : []
      if (item.getURL() !== url && !chain.includes(url) && item.getFilename() !== expectName) return
      started = true
      clearTimeout(timer)
      ses.removeListener('will-download', onWillDownload)
      const dest = path.join(destDir, item.getFilename())
      item.setSavePath(dest)
      item.on('updated', (_e, state) => {
        if (state !== 'progressing') return
        const total = item.getTotalBytes()
        sendToRenderer(IPC.updateStatus, {
          status: 'downloading',
          percent: total > 0 ? (item.getReceivedBytes() / total) * 100 : 0,
        })
      })
      item.once('done', (_e, state) => {
        if (state === 'completed') resolve(dest)
        else reject(new Error(`下载未完成（${state}）`))
      })
    }

    ses.on('will-download', onWillDownload)
    ses.downloadURL(url)
  })
}

/**
 * macOS 更新安装包下载：把 dmg 下到用户的下载目录并引导手动安装。
 * 依次做 sha512 校验（防截断/篡改）与清除下载隔离标记（防 Gatekeeper 判
 * 「已损坏」），完成后弹窗引导「关闭应用并打开安装包」。
 * @param {import('electron-updater').UpdateInfo} info
 */
async function downloadMacInstaller(info) {
  try {
    const file = (info.files || []).find((f) => /\.dmg$/i.test(f.url || ''))
    if (!file) throw new Error('更新元数据里没有 dmg 条目')
    const dest = await downloadToFile(file.url, app.getPath('downloads'))
    await verifySha512(dest, file.sha512)
    // 去掉下载隔离标记：否则用户拖进「应用程序」的 app 会被 Gatekeeper 拦下
    await clearQuarantine(dest)
    downloadedInstallerPath = dest
    sendToRenderer(IPC.updateStatus, { status: 'downloaded', path: dest })
    const { response } = await showMessageBoxSafe({
      type: 'info',
      title: 'TMD',
      message: '安装包已下载',
      detail: `${dest}\n\n点击「关闭应用并打开安装包」会退出应用并弹出安装窗口，把 TMD 拖入「应用程序」即可完成安装。`,
      buttons: ['关闭应用并打开安装包', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) void openDownloadedInstallerAndQuit()
  } catch (err) {
    sendToRenderer(IPC.updateStatus, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 打开已下载的 dmg 并退出应用（下载完成弹窗与设置面板「打开安装包」共用）。
 * 有未保存修改时先三选处置（保存 / 放弃 / 取消）。顺序上先 openPath 挂载
 * dmg 再退出应用：安装窗口由 Finder 接管，应用退出后依然显示，避免
 * 「点了之后应用关了却什么都没发生」的空窗。
 * @returns {Promise<void>}
 */
async function openDownloadedInstallerAndQuit() {
  if (!downloadedInstallerPath) return
  try {
    if (rendererDirty && mainWindow) {
      const { response } = await showMessageBoxSafe({
        type: 'warning',
        title: 'TMD',
        message: '准备安装更新',
        detail: '有未保存的修改，关闭应用前需要先处理。',
        buttons: ['保存并继续安装', '放弃修改并继续安装', '取消'],
        // 默认落在「保存并继续安装」：数据安全优先
        defaultId: 0,
        cancelId: 2,
      })
      if (response === 2) return
      if (response === 1) {
        // 与关闭确认的「放弃修改并关闭」同语义：清恢复副本，防止被放弃的
        // 内容以恢复副本"复活"
        rendererDirty = false
        await clearRendererRecoveryCopy()
      } else {
        const saved = await requestRendererSave()
        if (!saved) {
          // 保存失败/被另存为取消（渲染层已 toast 过失败原因）：留在应用内
          showMessageBoxSafe({
            type: 'info',
            title: 'TMD',
            message: '暂不安装',
            detail: '文档未能保存，应用没有关闭。稍后可在设置面板重新打开安装包。',
            buttons: ['确定'],
            defaultId: 0,
          }).catch(() => {})
          return
        }
      }
    }
    const openErr = await shell.openPath(downloadedInstallerPath)
    if (openErr) {
      // 失败时给出明确提示并留在应用内，避免用户点了没反应
      await showMessageBoxSafe({
        type: 'warning',
        title: 'TMD',
        message: '无法打开安装包',
        detail: `${openErr}\n\n请手动到「下载」目录打开该文件。`,
        buttons: ['确定'],
      })
      return
    }
    app.quit()
  } catch (err) {
    console.warn('[tmd] 打开安装包流程中断', err)
  }
}

/**
 * 装配自动更新：监听 electron-updater 事件，经 IPC 推送状态给渲染层。
 * 发现新版本后用原生 dialog 询问用户，不静默下载。
 * macOS 为 ad-hoc 签名构建（package.json 的 build.mac.identity = "-"，不使用
 * 开发者证书）；ad-hoc 已能满足 Squirrel.Mac 的签名校验，此处不再额外强制校验。
 */

function setupAutoUpdater() {
  // 不自动下载：发现新版本后弹窗问用户
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // 初始源：Gitee（国内）
  setUpdateSource('gitee')

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer(IPC.updateStatus, { status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    sendToRenderer(IPC.updateStatus, {
      status: 'available',
      version: info.version,
    })
    lastUpdateInfo = info
    const isMac = process.platform === 'darwin'
    /** @type {import('electron').MessageBoxOptions} */
    const boxOptions = {
      type: 'info',
      title: 'TMD',
      message: `发现新版本 ${info.version}`,
      detail: isMac
        ? '是否下载安装包？下载后需手动打开并拖入「应用程序」完成安装。'
        : '是否立即下载更新？',
      buttons: isMac ? ['下载安装包', '稍后'] : ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }
    // 主窗口可能已关闭（自动更新是应用级事件）：无窗口时以无父窗模式弹出
    showMessageBoxSafe(boxOptions)
      .then(({ response }) => {
        if (response === 0) {
          if (isMac) {
            // 不走 autoUpdater.downloadUpdate()：macOS 交给 Squirrel.Mac 的
            // 路径实测不可靠（见 downloadMacInstaller 处注释），改为自行
            // 下载 dmg 引导手动安装
            void downloadMacInstaller(info)
          } else {
            autoUpdater.downloadUpdate().catch((err) => {
              sendToRenderer(IPC.updateStatus, {
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
              })
            })
          }
        } else {
          sendToRenderer(IPC.updateStatus, { status: 'idle' })
        }
      })
  })

  autoUpdater.on('update-not-available', () => {
    sendToRenderer(IPC.updateStatus, { status: 'not-available' })
    // 仅手动检查（菜单）时弹窗告知「已最新」；启动时的自动检查静默——
    // 否则开启「启动时检查更新」的用户每次启动都被弹窗打扰
    if (updateCheckManual) {
      showMessageBoxSafe({
        type: 'info',
        title: 'TMD',
        message: '当前已是最新版本',
        buttons: ['确定'],
      })
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer(IPC.updateStatus, {
      status: 'downloading',
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', () => {
    sendToRenderer(IPC.updateStatus, { status: 'downloaded' })
    void installDownloadedUpdate()
  })

  autoUpdater.on('error', (err) => {
    // 当前源为 Gitee 且尚未因出错切换过：切换到 GitHub 重试一次
    if (currentUpdateSource === 'gitee' && !updateSourceSwitched) {
      updateSourceSwitched = true
      currentUpdateSource = 'github'
      autoUpdater.setFeedURL(GITHUB_SOURCE)
      autoUpdater.checkForUpdates().catch(() => {
        // 切换后仍失败：error 事件会再次触发，此时 currentUpdateSource === 'github'
        // 落到下面的 error 状态推送
      })
      return
    }
    sendToRenderer(IPC.updateStatus, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  })
}

// ---------- IPC：文件与目录 ----------

/** @type {import('electron').FileFilter[]} */
const MD_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]

ipcMain.handle(IPC.openFile, async () => {
  const result = await showOpenDialogSafe({
    filters: MD_FILTERS,
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = result.filePaths[0]
  const content = await fs.readFile(filePath, 'utf-8')
  return { path: filePath, name: path.basename(filePath), content }
})

/** @param {unknown} _event @param {string} filePath */
ipcMain.handle(IPC.readFile, async (_event, filePath) => {
  // IPC 入参不可信：非字符串/空路径直接拒绝，避免 fs 错误直穿渲染层
  if (typeof filePath !== 'string' || !filePath) throw new Error('invalid path')
  const content = await fs.readFile(filePath, 'utf-8')
  return { path: filePath, name: path.basename(filePath), content }
})

// 列出文件夹内的 Markdown 文件与子文件夹（两层），用于文件树侧边栏
/** @param {unknown} _event @param {string} dirPath */
ipcMain.handle(IPC.readDir, async (_event, dirPath) => {
  /**
   * @param {string} dir
   * @param {number} depth
   * @returns {Promise<import('../src/filetree.ts').FileEntry[]>}
   */
  async function walk(dir, depth) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    /** @type {import('../src/filetree.ts').FileEntry[]} */
    const folders = []
    /** @type {import('../src/filetree.ts').FileEntry[]} */
    const files = []
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, sortLocale || app.getLocale()),
    )) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0)
          folders.push({ name: entry.name, path: full, children: await walk(full, depth - 1) })
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        files.push({ name: entry.name, path: full })
      }
    }
    return [...folders, ...files]
  }
  try {
    return { path: dirPath, name: path.basename(dirPath), children: await walk(dirPath, 1) }
  } catch {
    return null
  }
})

// ---------- 跨文件全文搜索 ----------

/** @param {unknown} _event @param {unknown} roots @param {unknown} query */
ipcMain.handle(IPC.searchFiles, async (_event, roots, query) => {
  /** @type {import('../src/native.ts').SearchResult} */
  const empty = { matches: [], fileCount: 0, scannedFiles: 0, truncated: false, elapsedMs: 0 }
  if (!Array.isArray(roots) || typeof query !== 'string') return empty
  const needle = query.trim().toLowerCase()
  const dirs = roots.filter((r) => typeof r === 'string' && r !== '')
  if (!needle || !dirs.length) return empty

  const started = Date.now()
  const collected = await collectSearchFiles(dirs, SEARCH_MAX_FILES)
  const searched = await searchInFiles(collected.files, needle, SEARCH_MAX_MATCHES)
  return {
    matches: searched.matches,
    fileCount: searched.fileCount,
    scannedFiles: collected.files.length,
    truncated: collected.truncated || searched.truncated,
    elapsedMs: Date.now() - started,
  }
})

// ---------- 文件式主题（~/.tmd/themes/*.css） ----------
// 主题目录基于 tmdRoot（TMD_HOME_DIR 可重定位）而非硬编码真实主目录：
// history/logs/crash-dumps 均随 tmdRoot 走，主题不跟随会破坏 E2E 隔离与便携版约定

/** 列出主题目录中的全部主题文件 + 目录绝对路径（目录不存在返回空列表） */
ipcMain.handle(IPC.themesList, async () => {
  const dir = path.join(tmdRoot, 'themes')
  const themes = await listThemeFiles(dir, sortLocale || app.getLocale())
  return { dir, themes }
})

/** 读取单个主题文件内容（裸文件名经主进程 basename 校验，失败返回 null） */
/** @param {unknown} _event @param {unknown} name */
ipcMain.handle(IPC.themesRead, async (_event, name) => {
  const dir = path.join(tmdRoot, 'themes')
  return readThemeFile(dir, name)
})

/** 在系统文件管理器中打开主题目录：不存在则创建，并在空目录写入示例主题 */
ipcMain.handle(IPC.themesOpenDir, async () => {
  const dir = path.join(tmdRoot, 'themes')
  try {
    await ensureThemesDirWithSample(dir)
    const error = await shell.openPath(dir)
    return !error
  } catch (err) {
    console.error('[tmd] 打开主题目录失败', err)
    return false
  }
})

// ---------- IPC：日志与诊断（零遥传，仅本地落盘） ----------

/**
 * 渲染层未捕获异常上报：经白名单归一化后落盘。
 * 级别固定 error、来源固定 renderer（不接受客户端指定），载荷只取
 * message/stack/代码位置，任何文档内容都不会进入日志。
 * @param {unknown} _event
 * @param {unknown} payload
 */
ipcMain.on(IPC.logReport, (_event, payload) => {
  const entry = normalizeRendererReport(payload)
  if (!entry) return
  logger.log('error', 'renderer', entry.message, entry.stack, {
    filename: entry.filename,
    lineno: entry.lineno,
    colno: entry.colno,
  })
})

/** 在系统文件管理器中打开日志目录：不存在则创建（空目录即可，不写示例文件） */
ipcMain.handle(IPC.logOpenDir, async () => {
  try {
    const dir = logsDir(tmdRoot)
    await fs.mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    return !error
  } catch (err) {
    console.warn('[tmd] 打开日志目录失败', err)
    return false
  }
})

/** @param {unknown} _event @param {string} filePath @param {string} content */
ipcMain.handle(IPC.saveFile, async (_event, filePath, content) => {
  if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
    throw new Error('invalid save payload')
  }
  // 先留旧版快照再覆盖：这是「历史版本」唯一的产生点（自动保存同样经此路径）
  await snapshotBeforeWrite(filePath)
  await fs.writeFile(filePath, content, 'utf-8')
  // 登记自身写入的新指纹：随后的文件事件按指纹比对自然被过滤，不会误报外部修改
  fileWatcher.noteWrite(filePath, content)
  return true
})

/** @param {unknown} _event @param {string} content */
ipcMain.handle(IPC.saveFileAs, async (_event, content) => {
  if (typeof content !== 'string') return null
  const result = await showSaveDialogSafe({
    defaultPath: '未命名.md',
    filters: MD_FILTERS,
  })
  if (result.canceled || !result.filePath) return null
  // 另存为若覆盖了已存在的文件，那份内容同样值得留档
  await snapshotBeforeWrite(result.filePath)
  await fs.writeFile(result.filePath, content, 'utf-8')
  fileWatcher.noteWrite(result.filePath, content)
  return { path: result.filePath, name: path.basename(result.filePath) }
})

/** 外部修改监视：渲染层全量同步「已打开文件」集合，主进程差量增删 watcher */
ipcMain.handle(IPC.watchFiles, (_event, paths) => {
  fileWatcher.sync(paths)
  return true
})

// ---------- 侧边栏文件管理（新建 / 重命名 / 在系统中显示） ----------
// 名称经 fsops.cjs 清洗 + 路径二次校验；已存在时抛错（wx / recursive:false），
// 渲染层捕获后 toast，不覆盖任何现有文件。

/** @param {unknown} _event @param {string} dirPath @param {unknown} name */
ipcMain.handle(IPC.createFile, async (_event, dirPath, name) => {
  const safe = sanitizeFileName(name)
  const target = childPath(dirPath, ensureMarkdownExt(safe ?? ''))
  if (!target) throw new Error('invalid file name')
  await fs.writeFile(target, '', { flag: 'wx' })
  return { path: target, name: path.basename(target) }
})

/** @param {unknown} _event @param {string} dirPath @param {unknown} name */
ipcMain.handle(IPC.createDir, async (_event, dirPath, name) => {
  const target = childPath(dirPath, name)
  if (!target) throw new Error('invalid folder name')
  await fs.mkdir(target, { recursive: false })
  return { path: target, name: path.basename(target) }
})

/** @param {unknown} _event @param {string} oldPath @param {unknown} name */
ipcMain.handle(IPC.renamePath, async (_event, oldPath, name) => {
  if (typeof oldPath !== 'string' || !oldPath) throw new Error('invalid path')
  const target = childPath(path.dirname(oldPath), name)
  if (!target || target === oldPath) throw new Error('invalid rename target')
  await fs.rename(oldPath, target)
  return { path: target, name: path.basename(target) }
})

/** @param {unknown} _event @param {unknown} targetPath */
ipcMain.handle(IPC.revealInFolder, (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return false
  shell.showItemInFolder(targetPath)
  return true
})

/** 本地历史版本：列出某文件的快照清单（最新在前），无历史返回 null */
ipcMain.handle(IPC.historyList, async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return null
  return listSnapshots(historyRoot, filePath)
})

/** 本地历史版本：读取单条快照正文（id 合法性由 history.cjs 校验，防目录穿越） */
ipcMain.handle(IPC.historyRead, async (_event, filePath, id) => {
  if (typeof filePath !== 'string' || !filePath) return null
  return readSnapshot(historyRoot, filePath, id)
})

// 通用导出（HTML 等）：弹出另存为对话框并写入
/**
 * @param {unknown} _event
 * @param {{ content: string, defaultName: string, filters: { name: string, extensions: string[] }[] }} options
 */
ipcMain.handle(IPC.exportAs, async (_event, options) => {
  // IPC 入参不可信：缺 content 直接取消，其余字段做类型收敛后再交给对话框
  if (!options || typeof options.content !== 'string') return null
  const { content, defaultName, filters } = options
  const result = await showSaveDialogSafe({
    defaultPath: typeof defaultName === 'string' ? defaultName : undefined,
    filters: Array.isArray(filters) ? filters : undefined,
  })
  if (result.canceled || !result.filePath) return null
  await fs.writeFile(result.filePath, content, 'utf-8')
  return { path: result.filePath, name: path.basename(result.filePath) }
})

// 打印 / 导出 PDF（走系统打印对话框）
ipcMain.handle(IPC.print, async () => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return false
  // 等打印流程回调后再回结果：用户取消/无打印机时渲染层可据此提示
  return new Promise((resolve) => {
    win.webContents.print({ printBackground: true }, (success) => resolve(success))
  })
})

// 选择文件夹（文件树）
ipcMain.handle(IPC.openFolder, async () => {
  const result = await showOpenDialogSafe({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
})

// 渲染层同步未保存状态
/** @param {unknown} _event @param {unknown} dirty */
ipcMain.on(IPC.setDirty, (_event, dirty) => {
  rendererDirty = !!dirty
})

// 设置面板同步自动保存开关（保持菜单勾选状态一致）
/** @param {unknown} _event @param {unknown} enabled */
ipcMain.on(IPC.setAutosaveEnabled, (_event, enabled) => {
  autosaveEnabled = !!enabled
  if (autosaveMenuItem) autosaveMenuItem.checked = autosaveEnabled
})

// 渲染层主题同步：nativeTheme.themeSource 设置系统深浅色偏好，
// 渲染层 prefers-color-scheme 随动（两平台标题栏均已自绘/隐藏，随之一起变色）。
// 同步切换窗口底色（合成层颜色），消除切换瞬间内容区的白底闪烁；
// 持久化到 shell-state.json，下次启动在窗口创建前恢复。
// 用 handle + invoke：壳层切换完成后才返回，渲染层随后再翻页面，两者视觉同步
ipcMain.handle(IPC.setThemeSource, (_event, isDark) => {
  shellThemeSource = isDark ? 'dark' : 'light'
  nativeTheme.themeSource = shellThemeSource
  mainWindow?.setBackgroundColor(shellThemeSource === 'dark' ? SHELL_BG.dark : SHELL_BG.light)
  saveShellState({ themeSource: shellThemeSource })
})

// 自绘标题栏窗口控制（Windows/Linux 工具栏右侧 ─ □ ✕；Mac 无此 UI）。
// close() 走统一 close 流程：有未保存修改仍会先弹原生确认对话框
ipcMain.on(IPC.winMinimize, () => mainWindow?.minimize())
ipcMain.on(IPC.winMaximizeToggle, () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on(IPC.winClose, () => mainWindow?.close())

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

// ---------- IPC：链接跳转 ----------

// 外部链接：仅放行 http/https/mailto，防任意协议（file:/javascript: 等）注入系统打开器。
// 渲染层 IPC（openExternal）与主窗口 setWindowOpenHandler 共用此白名单
/** @param {unknown} url @returns {boolean} */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

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

// ---------- IPC：图床上传（PicGo-Core） ----------

/** PicGo 配置文件路径（userData 目录，随应用卸载清理） */
function picgoConfigPath() {
  return path.join(app.getPath('userData'), 'picgo-config.json')
}

/** 懒加载 PicGo 实例：配置文件放 userData，不使用默认的 ~/.picgo/config.json */
/** @type {import('picgo').PicGo | null} */
let picgoInstance = null
/** @returns {import('picgo').PicGo} */
function getPicGo() {
  if (!picgoInstance) {
    picgoInstance = new PicGo(picgoConfigPath())
  }
  return picgoInstance
}

/** 图床上传允许的图片扩展名（渲染层按 MIME 推导后传入，白名单外回落 .png） */
const UPLOAD_EXT_ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

/**
 * 上传图片到图床：渲染层传 base64 与扩展名，主进程写临时文件后交给 PicGo 上传，
 * 返回图片 URL；失败返回 null。
 * @param {unknown} _event
 * @param {unknown} base64  纯 base64 字符串（不含 data:image/...;base64, 前缀）
 * @param {unknown} ext     图片扩展名（如 '.png'，由渲染层按 MIME 推导）
 */
ipcMain.handle(IPC.uploadImage, async (_event, base64, ext) => {
  if (typeof base64 !== 'string' || !base64) return null
  // PicGo 按扩展名判定 mime，故由渲染层传入并在此校验；缺省/非法一律按 png
  const safeExt =
    typeof ext === 'string' && UPLOAD_EXT_ALLOWED.has(ext.toLowerCase())
      ? ext.toLowerCase()
      : '.png'
  let tmpFile = ''
  try {
    // 写临时文件：PicGo 的 path transformer 只接受文件路径。
    // 文件名带随机后缀：多个标签同时粘贴走图床时，仅用时间戳会撞名互相覆盖
    tmpFile = path.join(os.tmpdir(), `tmd-picgo-${randomUUID()}${safeExt}`)
    await fs.writeFile(tmpFile, Buffer.from(base64, 'base64'))
    const picgo = getPicGo()
    /** @type {unknown} */
    const result = await picgo.upload([tmpFile])
    if (Array.isArray(result) && result[0] && typeof result[0].imgUrl === 'string') {
      return result[0].imgUrl
    }
    return null
  } catch (err) {
    console.error('[tmd] 图床上传失败', err)
    return null
  } finally {
    // 清理临时文件
    if (tmpFile) {
      fs.unlink(tmpFile).catch(() => {})
    }
  }
})

/** 获取 PicGo 配置（图床类型及各图床参数） */
ipcMain.handle(IPC.getPicGoConfig, async () => {
  try {
    const picgo = getPicGo()
    const config = picgo.getConfig()
    // picBed 包含 current（当前图床）和各图床参数
    return config.picBed || { current: '' }
  } catch (err) {
    console.error('[tmd] 获取 PicGo 配置失败', err)
    return { current: '' }
  }
})

/** 保存 PicGo 配置到 userData 目录 */
/** @param {unknown} _event @param {unknown} config */
ipcMain.handle(IPC.savePicGoConfig, async (_event, config) => {
  if (!config || typeof config !== 'object') return false
  try {
    const picgo = getPicGo()
    // saveConfig 会写入配置文件并持久化
    picgo.saveConfig({ picBed: config })
    return true
  } catch (err) {
    console.error('[tmd] 保存 PicGo 配置失败', err)
    return false
  }
})

// 渲染层同步快捷键配置，更新菜单 accelerator
ipcMain.on(IPC.syncShortcuts, (_event, shortcuts) => {
  if (shortcuts && typeof shortcuts === 'object') {
    customShortcuts = shortcuts
    buildMenu()
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
    menuLabels = { ...DEFAULT_MENU_LABELS, ...info.labels }
    buildMenu()
  }
  if (info?.locale) sortLocale = COLLATION_LOCALE[info.locale] ?? info.locale
})

// ---------- IPC：最近文件 ----------
// 最近文件列表的权威在渲染层 localStorage（侧边栏/快速切换共用），
// 主进程只保留镜像用于原生菜单，并负责系统级最近文档注册。

// 启动全量同步：仅重建菜单，不触碰系统最近文档（避免启动顺序误清/误加）
/** @param {unknown} _event @param {unknown} entries */
ipcMain.on(IPC.recentSync, (_event, entries) => {
  recentDocs = normalizeRecent(entries)
  buildMenu()
})

// 新增/打开：注册到系统最近文档（Windows Jump List / macOS Dock 菜单 / Linux recent），
// 镜像列表去重置顶（限量 8）后重建菜单
/** @param {unknown} _event @param {unknown} entry */
ipcMain.on(IPC.recentAdd, (_event, entry) => {
  const [first] = normalizeRecent([entry])
  if (!first) return
  app.addRecentDocument(first.path)
  recentDocs = [first, ...recentDocs.filter((r) => r.path !== first.path)].slice(0, 8)
  buildMenu()
})

// 清空：系统最近文档与镜像列表一并清空
ipcMain.on(IPC.recentClear, () => {
  app.clearRecentDocuments()
  recentDocs = []
  buildMenu()
})

// 移除单条：Electron 无单条删除系统最近文档的 API，
// 先清空再按剩余条目从旧到新重新注册（addRecentDocument 每次置顶，最新最后加）
/** @param {unknown} _event @param {unknown} filePath */
ipcMain.on(IPC.recentRemove, (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return
  const next = recentDocs.filter((r) => r.path !== filePath)
  if (next.length === recentDocs.length) return
  app.clearRecentDocuments()
  for (const entry of [...next].reverse()) app.addRecentDocument(entry.path)
  recentDocs = next
  buildMenu()
})

// ---------- IPC：更新 ----------

// 手动检查更新：重置源为 Gitee，并标记来源——「已是最新版本」的弹窗只对
// 手动检查生效（自动检查静默，见 update-not-available 处理器）
ipcMain.handle(IPC.updateCheck, async () => {
  updateCheckManual = true
  setUpdateSource('gitee')
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    sendToRenderer(IPC.updateStatus, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

// 用户同意下载
ipcMain.handle(IPC.updateDownload, async () => {
  try {
    // macOS 不走 electron-updater 下载（Squirrel 路径不可靠，见
    // downloadMacInstaller 注释）：从最近一次 update-available 的元数据
    // 自行下载 dmg
    if (process.platform === 'darwin') {
      if (lastUpdateInfo) await downloadMacInstaller(lastUpdateInfo)
      return
    }
    await autoUpdater.downloadUpdate()
  } catch (err) {
    sendToRenderer(IPC.updateStatus, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

// 安装已下载的更新：macOS 打开 dmg 引导手动安装并退出应用；
// Windows 走 electron-updater 重启安装（有未保存修改时先三选处置）
ipcMain.handle(IPC.updateInstall, () => {
  if (process.platform === 'darwin') {
    void openDownloadedInstallerAndQuit()
  } else {
    void installDownloadedUpdate()
  }
})

// 渲染层同步"启动时自动检查更新"开关
/** @param {unknown} _event @param {unknown} enabled */
ipcMain.on(IPC.updateAutoCheck, (_event, enabled) => {
  autoCheckUpdateEnabled = !!enabled
})

// ---------- 生命周期 ----------

// 单实例：再次双击 .md / 启动应用时，把文件转交给已运行的实例
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // 用 exit(0) 而非 quit()：quit() 是异步的，whenReady 可能在退出前
  // 触发并创建窗口，导致第二个实例闪一下窗口才消失。exit() 立即终止进程。
  app.exit(0)
}

app.on('second-instance', (_event, argv) => {
  // 拖多个文件到任务栏图标 / 选中多个 .md 打开时逐个入队（渲染层有多标签承载）
  for (const filePath of argv.filter((arg) => /\.(md|markdown)$/i.test(arg))) {
    queueOpenPath(filePath)
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// macOS：Finder 双击 / 系统打开方式
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueOpenPath(filePath)
})

// ---------- 壳层持久化状态 ----------
// 目前仅存主题。存于 userData/shell-state.json（随应用卸载清理）。
// 启动时在 createWindow() 之前恢复，使两平台的启动外观从第一帧起就正确——
// 纯统一实现，不含平台分支。

/** 壳层状态文件路径 */
const shellStateFile = path.join(app.getPath('userData'), 'shell-state.json')

/**
 * 读取壳层持久化状态
 *
 * 文件缺失或解析失败时静默返回空对象（首次启动 / 文件损坏均视为无状态）。
 *
 * @returns {Record<string, unknown>} 已保存的状态，可能为空对象
 */
function readShellState() {
  try {
    const state = JSON.parse(fsSync.readFileSync(shellStateFile, 'utf-8'))
    return state && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

/** 写入串行链：读改写挂同一条 Promise 链，两次紧邻调用不会各自基于旧快照
 * 互相覆盖（与 logger 的单链写盘同构） */
let shellStateQueue = Promise.resolve()

/**
 * 增量写入壳层持久化状态（fire-and-forget，调用方无需等待落盘）
 *
 * @param {Record<string, unknown>} patch 要合并的状态片段
 * @returns {void}
 */
function saveShellState(patch) {
  shellStateQueue = shellStateQueue.then(() => {
    const state = { ...readShellState(), ...patch }
    const tmp = `${shellStateFile}.tmp`
    // 走临时文件 + 原子替换：直接覆盖时进程中断会留下截断的 JSON，
    // 下次启动 readShellState 解析失败即丢失全部壳层状态
    return fs
      .writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
      .then(() => fs.rename(tmp, shellStateFile))
  }).catch(() => {
    // 写失败静默：壳层状态只影响下次启动的主题外观，清理残留临时文件
    fs.unlink(`${shellStateFile}.tmp`).catch(() => {})
  })
}

app.whenReady().then(() => {
  // 双重保险：未获取单实例锁时不创建窗口（exit 已处理，但防止竞态）
  if (!gotSingleInstanceLock) return
  // 窗口创建前恢复上次主题：nativeTheme 与窗口底色在首帧渲染前生效，
  // 渲染层 prefers-color-scheme 启动即为正确外观（自绘标题栏同帧正确）
  const savedTheme = readShellState().themeSource
  if (savedTheme === 'dark' || savedTheme === 'light') {
    shellThemeSource = savedTheme
    nativeTheme.themeSource = savedTheme
  }
  buildMenu()
  createWindow()
  // 离屏导出服务：注册隐藏窗口的分区 CSP 与 4 条服务通道（窗口按需懒创建）
  exporter.register()
  // 登记上次运行可能留下的原生崩溃 minidump（主进程自身崩溃时来不及写日志行，
  // 只能在下次启动时于日志中补一条线索，并更新 .seen-dumps 清单避免重复登记）
  void scanNewDumps(logger, tmdRoot)
  // 装配自动更新事件监听（autoCheckUpdateEnabled 由渲染层经 IPC 同步）
  setupAutoUpdater()

  // Windows：文件路径在启动参数里
  const argvFile = process.argv.slice(1).find((arg) => /\.(md|markdown)$/i.test(arg))
  if (argvFile) queueOpenPath(argvFile)

  // 启动后 5 秒自动检查更新：仅当渲染层已同步开关为 true。
  // 渲染层 boot 时（wireSettings 内）会把 localStorage 的开关值发给主进程，
  // 该 IPC 通常在数毫秒内到达，远早于 5 秒延时。
  setTimeout(() => {
    if (autoCheckUpdateEnabled) {
      updateCheckManual = false
      setUpdateSource('gitee')
      autoUpdater.checkForUpdates().catch((err) => {
        sendToRenderer(IPC.updateStatus, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }, 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前释放离屏导出窗口（无持久状态，仅为干净退出）
app.on('will-quit', () => exporter.destroyWindow())
