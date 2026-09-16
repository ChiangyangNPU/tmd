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
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
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
/** @type {import('builder-util-runtime').GenericServerOptions} */
const GITEE_SOURCE = {
  provider: 'generic',
  url: 'https://gitee.com/chiangyangNPU/tmd/raw/main/releases/',
}
/** @type {import('builder-util-runtime').GithubOptions} */
const GITHUB_SOURCE = {
  provider: 'github',
  owner: 'ChiangyangNPU',
  repo: 'tmd',
}

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

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

/** 「打开最近文件」子菜单：有条目则附分隔线与清空项，空列表为禁用占位项
 * @returns {import('electron').MenuItemConstructorOptions[]} */
function recentSubmenu() {
  if (!recentDocs.length) {
    return [{ label: L('recentEmpty'), enabled: false }]
  }
  return [
    ...recentDocs.map((entry) => ({
      label: entry.name,
      click: () => sendToRenderer(IPC.recentOpen, entry.path),
    })),
    { type: 'separator' },
    {
      label: L('clearRecent'),
      // 清空动作交给渲染层执行（localStorage 是唯一权威），走统一菜单消息通道
      click: () => sendToRenderer(IPC.menu, 'clear-recent'),
    },
  ]
}

// ---------- 自动更新状态 ----------
/** @type {'gitee' | 'github'} */
let currentUpdateSource = 'gitee'
/** 启动时是否自动检查更新（由渲染层经 updateAutoCheck IPC 同步，默认 false） */
let autoCheckUpdateEnabled = false
/** 是否已因出错切换过源（避免 error 事件中无限切换重试） */
let updateSourceSwitched = false

// 菜单文案：默认中文，渲染层启动后把当前语言的文案经 IPC 发来并重建菜单
/** @type {Record<string, string>} */
const DEFAULT_MENU_LABELS = {
  file: '文件',
  open: '打开',
  openFolder: '打开文件夹',
  openRecent: '打开最近文件',
  recentEmpty: '（无最近文件）',
  clearRecent: '清空最近文件',
  save: '保存',
  saveAs: '另存为',
  newTab: '新标签页',
  closeTab: '关闭标签页',
  autosave: '自动保存到文件',
  export: '导出',
  exportHtml: '导出 HTML',
  exportPdf: '打印 / 导出 PDF',
  format: '格式',
  bold: '加粗',
  italic: '斜体',
  strike: '删除线',
  inlineCode: '行内代码',
  highlight: '高亮',
  superscript: '上标',
  subscript: '下标',
  link: '链接…',
  h1: '一级标题',
  h2: '二级标题',
  h3: '三级标题',
  h4: '四级标题',
  h5: '五级标题',
  h6: '六级标题',
  paragraph: '正文',
  quote: '引用',
  codeBlock: '代码块',
  bulletList: '无序列表',
  orderedList: '有序列表',
}
/** @type {Record<string, string>} */
let menuLabels = { ...DEFAULT_MENU_LABELS }

/**
 * 用户自定义快捷键配置：action → Electron accelerator。
 * 由渲染层通过 syncShortcuts IPC 同步过来，buildMenu 据此动态设置菜单 accelerator。
 * 空对象表示全部使用默认值（在 buildMenu 中硬编码的 accelerator）。
 * @type {Record<string, string>}
 */
let customShortcuts = {}

/** @param {string} key @returns {string} */
const L = (key) => menuLabels[key] ?? DEFAULT_MENU_LABELS[key]

/**
 * 获取菜单项的 accelerator：优先使用用户自定义配置，否则用默认值。
 * @param {string} action - 动作标识（与渲染层 shortcuts.ts 的 SHORTCUT_DEFS 对齐）
 * @param {string} fallback - 默认 accelerator
 * @returns {string}
 */
function acc(action, fallback) {
  return customShortcuts[action] ?? fallback
}

// 文件关联：Finder 双击 .md 时 macOS 通过 open-file 事件传入路径；
// 渲染层未就绪时先排队，收到 ready 信号后再发给渲染层
/** @type {string[]} */
const pendingOpenPaths = []

/** @param {string} channel @param {unknown} payload */
function sendToRenderer(channel, payload) {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(channel, payload)
}

/** @param {string} filePath */
function queueOpenPath(filePath) {
  pendingOpenPaths.push(filePath)
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
 * 对话框父窗口：对话框仅由渲染层 IPC 触发，彼时必有窗口存活。
 * @returns {import('electron').BrowserWindow}
 */
function dialogParent() {
  return /** @type {import('electron').BrowserWindow} */ (
    mainWindow ?? BrowserWindow.getAllWindows()[0]
  )
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const macAppMenu = [{ role: 'appMenu' }]
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? macAppMenu : []),
    {
      label: L('file'),
      submenu: [
        {
          label: L('open'),
          accelerator: acc('open', 'CmdOrCtrl+O'),
          click: () => sendToRenderer(IPC.menu, 'open'),
        },
        {
          label: L('openFolder'),
          accelerator: acc('open-folder', 'CmdOrCtrl+Shift+O'),
          click: () => sendToRenderer(IPC.menu, 'open-folder'),
        },
        {
          label: L('openRecent'),
          submenu: recentSubmenu(),
        },
        {
          label: L('save'),
          accelerator: acc('save', 'CmdOrCtrl+S'),
          click: () => sendToRenderer(IPC.menu, 'save'),
        },
        {
          label: L('saveAs'),
          accelerator: acc('save-as', 'CmdOrCtrl+Shift+S'),
          click: () => sendToRenderer(IPC.menu, 'save-as'),
        },
        { type: 'separator' },
        {
          label: L('newTab'),
          accelerator: acc('new-tab', 'CmdOrCtrl+T'),
          click: () => sendToRenderer(IPC.menu, 'new-tab'),
        },
        {
          label: L('closeTab'),
          accelerator: acc('close-tab', 'CmdOrCtrl+W'),
          click: () => sendToRenderer(IPC.menu, 'close-tab'),
        },
        { type: 'separator' },
        {
          id: 'autosave',
          label: L('autosave'),
          type: 'checkbox',
          checked: autosaveEnabled,
          click: (item) => {
            autosaveEnabled = item.checked
            sendToRenderer(IPC.autosave, item.checked)
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: L('export'),
      submenu: [
        {
          label: L('exportHtml'),
          accelerator: acc('export-html', 'CmdOrCtrl+Shift+H'),
          click: () => sendToRenderer(IPC.menu, 'export-html'),
        },
        {
          label: L('exportPdf'),
          // Ctrl/Cmd+P 已让位给快速切换面板（高频优先），PDF 改 Shift+Mod+P
          accelerator: acc('export-pdf', 'CmdOrCtrl+Shift+P'),
          click: () => sendToRenderer(IPC.menu, 'export-pdf'),
        },
      ],
    },
    {
      // 格式栏：与渲染层 ProseMirror keymap 同一套命令（fmt-* action）。
      // accelerator 由菜单消费，不会同时触发渲染层 keymap；
      // mac 上 Cmd+Q 是退出应用，引用改用 Ctrl+Q（keymap 亦绑 Ctrl+q 兜底）
      label: L('format'),
      submenu: [
        {
          label: L('bold'),
          accelerator: acc('fmt-bold', 'CmdOrCtrl+B'),
          click: () => sendToRenderer(IPC.menu, 'fmt-bold'),
        },
        {
          label: L('italic'),
          accelerator: acc('fmt-italic', 'CmdOrCtrl+I'),
          click: () => sendToRenderer(IPC.menu, 'fmt-italic'),
        },
        {
          label: L('strike'),
          click: () => sendToRenderer(IPC.menu, 'fmt-strike'),
        },
        {
          label: L('inlineCode'),
          click: () => sendToRenderer(IPC.menu, 'fmt-code'),
        },
        {
          label: L('highlight'),
          accelerator: acc('fmt-mark', 'CmdOrCtrl+Shift+H'),
          click: () => sendToRenderer(IPC.menu, 'fmt-mark'),
        },
        {
          label: L('superscript'),
          accelerator: acc('fmt-sup', 'CmdOrCtrl+Shift+='),
          click: () => sendToRenderer(IPC.menu, 'fmt-sup'),
        },
        {
          label: L('subscript'),
          accelerator: acc('fmt-sub', 'CmdOrCtrl+Shift+-'),
          click: () => sendToRenderer(IPC.menu, 'fmt-sub'),
        },
        {
          label: L('link'),
          accelerator: acc('fmt-link', 'CmdOrCtrl+K'),
          click: () => sendToRenderer(IPC.menu, 'fmt-link'),
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          label: L(`h${level}`),
          accelerator: acc(`fmt-h${level}`, `CmdOrCtrl+${level}`),
          click: () => sendToRenderer(IPC.menu, `fmt-h${level}`),
        })),
        {
          label: L('paragraph'),
          accelerator: acc('fmt-paragraph', 'CmdOrCtrl+0'),
          click: () => sendToRenderer(IPC.menu, 'fmt-paragraph'),
        },
        { type: 'separator' },
        {
          label: L('quote'),
          accelerator: acc('fmt-quote', isMac ? 'Ctrl+Q' : 'CmdOrCtrl+Q'),
          click: () => sendToRenderer(IPC.menu, 'fmt-quote'),
        },
        {
          label: L('codeBlock'),
          accelerator: acc('fmt-codeblock', 'CmdOrCtrl+Shift+K'),
          click: () => sendToRenderer(IPC.menu, 'fmt-codeblock'),
        },
        {
          label: L('bulletList'),
          accelerator: acc('fmt-bullet', 'CmdOrCtrl+Shift+8'),
          click: () => sendToRenderer(IPC.menu, 'fmt-bullet'),
        },
        {
          label: L('orderedList'),
          accelerator: acc('fmt-ordered', 'CmdOrCtrl+Shift+9'),
          click: () => sendToRenderer(IPC.menu, 'fmt-ordered'),
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  autosaveMenuItem = Menu.getApplicationMenu()?.getMenuItemById('autosave') ?? null
}

function createWindow() {
  // CSP：注入到所有响应头，阻断渲染层加载非预期外部资源（防 XSS）。
  // script-src 'self'：禁止 eval/内联脚本；style-src 含 'unsafe-inline'
  // 是因为 Mermaid/KatTeX 生成的 SVG style 标签与 ProseMirror 装饰器依赖内联样式；
  // img-src 含 data: blob: 支持粘贴图片的内联 data URL 与文件树图标。
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

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'TMD',
    // 窗口底色跟随主题：深色启动时首帧即为深色底，杜绝白闪
    backgroundColor: shellThemeSource === 'dark' ? SHELL_BG.dark : SHELL_BG.light,
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

  // 窗口加载完成后，把排队中的待打开文件发给渲染层
  mainWindow.webContents.on('did-finish-load', () => {
    flushPendingOpenPaths()
  })

  // 兜底阻止页面导航：拖文件进窗口时 Chromium 默认会导航到该文件，
  // 渲染层 drop 处理器已 preventDefault，这里拦截漏网情况（应用为单页，无合法导航）
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
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
  mainWindow.on('close', (event) => {
    if (!rendererDirty) return
    event.preventDefault()
    dialog
      .showMessageBox(dialogParent(), {
        type: 'warning',
        message: '有未保存的修改',
        detail: '关闭前会丢失未保存的内容。',
        buttons: ['放弃修改并关闭', '取消'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(async ({ response }) => {
        if (response === 0) {
          rendererDirty = false
          // 用户明确放弃修改：绕过渲染层 beforeunload，需在主进程直接清除恢复副本，
          // 否则下次启动会"复活"被放弃的内容（与"放弃修改"语义冲突）。
          // 注意：此键名与渲染层 src/store.ts 的 DOC_KEY 一致，改键名时须同步
          try {
            await mainWindow?.webContents.executeJavaScript("localStorage.removeItem('tmd:doc:v1')")
          } catch (err) {
            console.warn('[tmd] 清除恢复副本失败', err)
          }
          mainWindow?.destroy()
        }
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
 * 装配自动更新：监听 electron-updater 事件，经 IPC 推送状态给渲染层。
 * 发现新版本后用原生 dialog 询问用户，不静默下载。
 * macOS 自用场景为未签名构建（package.json 的 build.mac 已设 identity: null），
 * 此处不强制签名校验。
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
    dialog
      .showMessageBox(dialogParent(), {
        type: 'info',
        title: 'TMD',
        message: `发现新版本 ${info.version}`,
        detail: '是否立即下载更新？',
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate().catch((err) => {
            sendToRenderer(IPC.updateStatus, {
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            })
          })
        } else {
          sendToRenderer(IPC.updateStatus, { status: 'idle' })
        }
      })
  })

  autoUpdater.on('update-not-available', () => {
    sendToRenderer(IPC.updateStatus, { status: 'not-available' })
    dialog.showMessageBox(dialogParent(), {
      type: 'info',
      title: 'TMD',
      message: '当前已是最新版本',
      buttons: ['确定'],
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer(IPC.updateStatus, {
      status: 'downloading',
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', () => {
    sendToRenderer(IPC.updateStatus, { status: 'downloaded' })
    dialog
      .showMessageBox(dialogParent(), {
        type: 'info',
        title: 'TMD',
        message: '下载完成，重启以安装',
        detail: '应用将关闭并安装更新后重新启动。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
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
  const result = await dialog.showOpenDialog(dialogParent(), {
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
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
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

/** @param {unknown} _event @param {string} filePath @param {string} content */
ipcMain.handle(IPC.saveFile, async (_event, filePath, content) => {
  await fs.writeFile(filePath, content, 'utf-8')
  return true
})

/** @param {unknown} _event @param {string} content */
ipcMain.handle(IPC.saveFileAs, async (_event, content) => {
  const result = await dialog.showSaveDialog(dialogParent(), {
    defaultPath: '未命名.md',
    filters: MD_FILTERS,
  })
  if (result.canceled || !result.filePath) return null
  await fs.writeFile(result.filePath, content, 'utf-8')
  return { path: result.filePath, name: path.basename(result.filePath) }
})

// 通用导出（HTML 等）：弹出另存为对话框并写入
/**
 * @param {unknown} _event
 * @param {{ content: string, defaultName: string, filters: { name: string, extensions: string[] }[] }} options
 */
ipcMain.handle(IPC.exportAs, async (_event, options) => {
  const { content, defaultName, filters } = options
  const result = await dialog.showSaveDialog(dialogParent(), { defaultPath: defaultName, filters })
  if (result.canceled || !result.filePath) return null
  await fs.writeFile(result.filePath, content, 'utf-8')
  return { path: result.filePath, name: path.basename(result.filePath) }
})

// 打印 / 导出 PDF（走系统打印对话框）
ipcMain.handle(IPC.print, async () => {
  mainWindow?.webContents.print({ printBackground: true })
  return true
})

// 选择文件夹（文件树）
ipcMain.handle(IPC.openFolder, async () => {
  const result = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory'] })
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

// 粘贴图片落盘：写入文档同目录 assets/ 文件夹（base64 解码后写入）
/** @param {unknown} _event @param {{ dir: string, name: string, base64: string }} options */
ipcMain.handle(IPC.saveImage, async (_event, options) => {
  const { dir, name, base64 } = options
  const assetsDir = path.join(dir, 'assets')
  await fs.mkdir(assetsDir, { recursive: true })
  const filePath = path.join(assetsDir, name)
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'))
  return { name }
})

// ---------- IPC：链接跳转 ----------

// 外部链接：仅放行 http/https/mailto，防任意协议（file:/javascript: 等）注入系统打开器
/** @param {unknown} _event @param {unknown} url */
ipcMain.handle(IPC.openExternal, (_event, url) => {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false
  } catch {
    return false
  }
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

/**
 * 上传图片到图床：渲染层传 base64，主进程写临时文件后交给 PicGo 上传，
 * 返回图片 URL；失败返回 null。
 * @param {unknown} _event
 * @param {unknown} base64  纯 base64 字符串（不含 data:image/...;base64, 前缀）
 */
ipcMain.handle(IPC.uploadImage, async (_event, base64) => {
  if (typeof base64 !== 'string' || !base64) return null
  let tmpFile = ''
  try {
    // 写临时文件：PicGo 的 path transformer 只接受文件路径
    const ext = base64.startsWith('/') ? 'jpg' : base64.startsWith('i') ? 'png' : 'png'
    tmpFile = path.join(os.tmpdir(), `tmd-picgo-${Date.now()}.${ext}`)
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

// 渲染层把当前语言的菜单文案发来，重建菜单
/** @param {unknown} _event @param {unknown} labels */
ipcMain.on(IPC.setLocaleInfo, (_event, labels) => {
  if (labels && typeof labels === 'object') {
    menuLabels = { ...DEFAULT_MENU_LABELS, ...labels }
    buildMenu()
  }
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

// 手动检查更新：重置源为 Gitee
ipcMain.handle(IPC.updateCheck, async () => {
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
    await autoUpdater.downloadUpdate()
  } catch (err) {
    sendToRenderer(IPC.updateStatus, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

// 安装已下载的更新
ipcMain.handle(IPC.updateInstall, () => {
  autoUpdater.quitAndInstall()
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
  const filePath = argv.find((arg) => /\.(md|markdown)$/i.test(arg))
  if (filePath) queueOpenPath(filePath)
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

/**
 * 增量写入壳层持久化状态（fire-and-forget，调用方无需等待落盘）
 *
 * @param {Record<string, unknown>} patch 要合并的状态片段
 * @returns {void}
 */
function saveShellState(patch) {
  const state = { ...readShellState(), ...patch }
  fs.writeFile(shellStateFile, JSON.stringify(state, null, 2), 'utf-8').catch(() => {})
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
