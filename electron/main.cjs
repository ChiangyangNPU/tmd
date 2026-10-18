/**
 * TMD Electron 主进程
 *
 * 职责：创建窗口、应用菜单（文件操作/导出快捷键）、模块装配与生命周期。
 * 渲染层保持纯网页逻辑，所有 Node 能力都经由 preload 暴露的受控 API 访问。
 *
 * 模块结构（均为工厂 + 依赖注入，可脱离 Electron 单测）：
 * - app-state.cjs：跨模块共享可变状态（主窗口/脏标记/菜单文案/主题来源等）
 * - shell-state.cjs：壳层状态持久化（主题来源 + 窗口几何）
 * - ipc-files.cjs：文件/目录/搜索/双链/主题/日志/历史/导出/打印 IPC
 * - ipc-app.cjs：状态同步/窗口控制/图片落盘/链接跳转 IPC
 * - updater.cjs：自动更新（双源切换、macOS dmg 自行下载安装）
 * - recent.cjs：最近文件镜像 + 系统最近文档注册
 * - picgo.cjs：图床上传（PicGo-Core）
 * - exporter.cjs：离屏导出服务（Word / 长图）
 *
 * 本文件只保留：窗口与菜单生命周期（createWindow / buildMenu）、文件关联
 * （open-file 事件 + 单实例锁）、渲染层桥接辅助（sendToRenderer / 对话框）、
 * 以及 whenReady 装配。
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
  screen,
  session,
  shell,
} = require('electron')
const path = require('node:path')
const fsSync = require('node:fs')
const { createFileWatcher } = require('./filewatcher.cjs')
const { createDirWatcher } = require('./dirwatcher.cjs')
const { createExporter } = require('./exporter.cjs')
const { tmdHome, crashDumpsDir, createLogger, scanNewDumps } = require('./logger.cjs')
// 应用菜单模板：纯数据工厂（零 Electron 依赖，独立单测），状态与副作用注入见 buildMenu
const { buildMenuTemplate } = require('./menu.cjs')
const IPC = require('./ipc.cjs')
const state = require('./app-state.cjs')
const { createShellState } = require('./shell-state.cjs')
const { createRecent } = require('./recent.cjs')
const { createPicGo } = require('./picgo.cjs')
const { createUpdater } = require('./updater.cjs')
const { registerFileIpc } = require('./ipc-files.cjs')
const { registerAppIpc, isSafeExternalUrl } = require('./ipc-app.cjs')
// 图床上传：PicGo-Core（仅 Node 环境可用，故放在主进程）
const { PicGo } = require('picgo')
// 自动更新：electron-updater。开发模式（app.isPackaged === false）下
// checkForUpdates 会因找不到 latest.yml 报错，统一由 error 事件处理。
const { autoUpdater } = require('electron-updater')

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

/** @param {string} channel @param {unknown} [payload] */
function sendToRenderer(channel, payload) {
  // 只发主窗口：兜底取 getAllWindows()[0] 可能选中隐藏的离屏导出窗口——
  // 它没有对应的渲染层 handler，消息只会静默丢失；主窗口不在时干脆不发
  state.getMainWindow()?.webContents.send(channel, payload)
}

// ---------- 外部修改检测（打开文件的磁盘监视） ----------
// 渲染层把「已打开文件路径集合」全量同步过来（开关标签 / 另存为后），
// 这里差量挂 fs.watch；内容真变化时经 IPC 推给渲染层分流（干净自动重载 /
// 脏态弹条二选一）。指纹过滤保证自身保存不会误报。
const fileWatcher = createFileWatcher({
  onEvent: (info) => sendToRenderer(IPC.fileChanged, info),
})

// 侧边栏目录监视：渲染层把「已加载目录集合」全量同步过来（挂载/展开后），
// 外部增删改名时推给渲染层失效缓存并重读重渲染（非递归，只关心直接子项）
const dirWatcher = createDirWatcher({
  onChange: (dir) => sendToRenderer(IPC.dirsChanged, dir),
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
      state.getMainWindow()?.webContents.executeJavaScript("localStorage.removeItem('tmd:doc:v1')"),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch (err) {
    console.warn('[tmd] 清除恢复副本失败', err)
  }
}

// 文件关联：Finder 双击 .md 时 macOS 通过 open-file 事件传入路径；
// 渲染层未就绪时先排队，收到 ready 信号后再发给渲染层
/** @type {string[]} */
const pendingOpenPaths = []

/** @param {string} filePath */
function queueOpenPath(filePath) {
  pendingOpenPaths.push(filePath)
  // ready 前不能建窗口（macOS 经文件关联启动时 open-file 早于 ready 到达）：
  // 路径已在队列里，whenReady → createWindow → did-finish-load 会补发，
  // 这里提前 createWindow 只会抛 "Cannot create BrowserWindow before app is ready"
  if (!app.isReady()) return
  const mainWindow = state.getMainWindow()
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
  const mainWindow = state.getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    app.focus({ steal: true })
  }
}

/**
 * 对话框父窗口：优先主窗口；主窗口已关而离屏导出窗口尚存时，不得把隐藏的
 * 导出窗口当父窗（模态弹窗会显示在看不见的地方）。主窗口不在时返回 null
 * （无父窗模式弹出）。
 * @returns {import('electron').BrowserWindow | null}
 */
function dialogParent() {
  return state.getMainWindow()
}

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

// ---------- 领域服务装配 ----------

// 壳层状态持久化：主题来源 + 窗口几何（userData/shell-state.json）
const shellState = createShellState({ app, screen })

// 最近文件：镜像渲染层列表供原生菜单，并负责系统最近文档注册
const recent = createRecent({ app, ipcMain, IPC, onMenuChange: () => buildMenu() })

// 图床上传：PicGo 实例懒加载，配置存 userData/picgo-config.json
const picgo = createPicGo({ ipcMain, IPC, app, PicGo })

// 离屏导出服务（Word / 长图）：隐藏窗口单例 + 串行队列，编排逻辑在离屏页
const exporter = createExporter({
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  IPC,
  rendererUrl: DEV_SERVER_URL,
  getParentWindow: () => state.getMainWindow(),
})

// 自动更新：双源切换 + macOS dmg 自行下载安装
// getDefaultSession 用 lazy getter：session.defaultSession 在 app ready 前访问会抛错
// （"Session can only be received when app is ready"），而本装配在模块顶层执行
const updater = createUpdater({
  autoUpdater,
  ipcMain,
  shell,
  app,
  getDefaultSession: () => session.defaultSession,
  IPC,
  sendToRenderer,
  showMessageBoxSafe,
  clearRendererRecoveryCopy,
})

// 注册全部 IPC（与原实现同为模块顶层注册，语义不变）
registerFileIpc({
  ipcMain,
  shell,
  app,
  IPC,
  fileWatcher,
  dirWatcher,
  logger,
  showOpenDialogSafe,
  showSaveDialogSafe,
})
registerAppIpc({
  ipcMain,
  nativeTheme,
  shell,
  IPC,
  saveShellState: (patch) => shellState.saveShellState(patch),
  rebuildMenu: () => buildMenu(),
  flushPendingOpenPaths,
  getAutosaveMenuItem: () => autosaveMenuItem,
})
recent.register()
picgo.register()
updater.registerIpc()

// ---------- 应用菜单 ----------

/** @type {import('electron').MenuItem | null} */
let autosaveMenuItem = null

/**
 * 构建（并设置）应用菜单。
 *
 * 菜单文案取自渲染层下发的语言包（menuLabels），渲染层未就绪时用中文兜底；
 * 各菜单项的 accelerator 优先使用用户自定义快捷键（customShortcuts），
 * 未自定义时回落到内置默认值。渲染层切换语言或改动快捷键后会再次调用本函数重建。
 */
function buildMenu() {
  // 模板构建抽至 menu.cjs（纯数据工厂，可独立单测）；本函数只注入状态与副作用：
  // - labels/shortcuts/recents/autosaveEnabled 为共享状态快照
  // - 三个回调把「动作分发 / 最近文件打开 / 自动保存开关」反转回主进程 IPC
  const template = buildMenuTemplate({
    labels: state.getMenuLabels(),
    shortcuts: state.getCustomShortcuts(),
    recents: recent.getRecents(),
    autosaveEnabled: state.isAutosaveEnabled(),
    isMac: process.platform === 'darwin',
    onAction: (action) => sendToRenderer(IPC.menu, action),
    onRecentOpen: (recentPath) => sendToRenderer(IPC.recentOpen, recentPath),
    onAutosaveToggle: (enabled) => {
      state.setAutosaveEnabled(enabled)
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

  // 恢复上次窗口几何（shell-state 的 winState）：无记录/坐标悬空时回落默认尺寸
  const winState = shellState.restoreWinState()
  const shellThemeSource = state.getShellThemeSource()
  const mainWindow = new BrowserWindow({
    width: winState?.width ?? 1000,
    height: winState?.height ?? 800,
    ...(winState?.x != null ? { x: winState.x, y: winState.y } : {}),
    minWidth: 860,
    minHeight: 560,
    title: 'TMD',
    // 窗口底色跟随主题：ready-to-show 前窗口不可见，此底色仅作兜底
    // （如加载失败页），保证任何情况下露出的都是当前深浅色的底
    backgroundColor: shellThemeSource === 'dark' ? state.SHELL_BG.dark : state.SHELL_BG.light,
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
  state.setMainWindow(mainWindow)

  // 上次关闭时为最大化：隐藏态先恢复最大化，ready-to-show 一并显示无跳变
  if (winState?.maximized) mainWindow.maximize()
  // 记录窗口几何：移动/缩放防抖落盘，关闭时同步兜底（见 shell-state.cjs）
  shellState.wireWinStatePersistence(mainWindow)

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
    state.setMainWindow(null)
  })

  // 最大化状态推送：渲染层据此切换自绘按钮的 □/❐ 图标
  const pushMaximized = () =>
    sendToRenderer(IPC.winMaxChanged, state.getMainWindow()?.isMaximized() === true)
  mainWindow.on('maximize', pushMaximized)
  mainWindow.on('unmaximize', pushMaximized)

  // 未保存关闭确认：渲染层通过 IPC 同步脏标记，这里用原生对话框拦截关闭。
  // 不能在渲染层用 window.confirm —— Electron 关闭流程中它不可靠，会导致窗口无法关闭。
  // closingDialogOpen：对话框弹出期间再点自绘 ✕ 会再次触发 close——不做防重入
  // 会叠出多个对话框，且各自回调交错执行 destroy 与 rendererDirty 复位
  let closingDialogOpen = false
  mainWindow.on('close', (event) => {
    if (!state.isRendererDirty() || closingDialogOpen) return
    if (!state.getMainWindow()) return
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
        state.setRendererDirty(false)
        await clearRendererRecoveryCopy()
        state.getMainWindow()?.destroy()
      })
      .catch((err) => {
        // 对话框本身失败（极少见）：复位防重入，让用户能再次发起关闭
        closingDialogOpen = false
        console.warn('[tmd] 关闭确认对话框失败', err)
      })
  })
}

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
  for (const filePath of argv.filter((arg) => /\.(md|markdown|txt)$/i.test(arg))) {
    queueOpenPath(filePath)
  }
  const mainWindow = state.getMainWindow()
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

app.whenReady().then(() => {
  // 双重保险：未获取单实例锁时不创建窗口（exit 已处理，但防止竞态）
  if (!gotSingleInstanceLock) return
  // 窗口创建前恢复上次主题：nativeTheme 与窗口底色在首帧渲染前生效，
  // 渲染层 prefers-color-scheme 启动即为正确外观（自绘标题栏同帧正确）
  const savedTheme = shellState.readShellState().themeSource
  if (savedTheme === 'dark' || savedTheme === 'light') {
    state.setShellThemeSource(savedTheme)
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
  updater.setup()
  // 启动后 5 秒自动检查更新（仅当渲染层已同步开关为 true）
  updater.scheduleAutoCheck()

  // Windows：文件路径在启动参数里
  const argvFile = process.argv.slice(1).find((arg) => /\.(md|markdown|txt)$/i.test(arg))
  if (argvFile) queueOpenPath(argvFile)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前释放离屏导出窗口（无持久状态，仅为干净退出）
app.on('will-quit', () => exporter.destroyWindow())
