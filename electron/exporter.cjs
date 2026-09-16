/**
 * 离屏导出服务（Word / 长图）。
 *
 * 职责（薄壳）：管理一个 show:false 的隐藏渲染窗口（单例，跨任务复用），
 * 提供三类 Electron 独有原语：
 *   1. 保存对话框 + 结果落盘（export-run / exporter-done 配对）
 *   2. 视口尺寸设置 + 截帧（exporter-capture）
 *   3. 本地图片白名单读盘转 data URI（exporter-read-image）
 * 真正的编排（Markdown 注入、mermaid/katex 渲染、分段、拼接、OOXML 转换）
 * 全在离屏页 TypeScript 侧（src/export-renderer.ts），因此这里的逻辑保持极薄。
 *
 * 依赖注入（BrowserWindow/session/ipcMain/dialog 由 main.cjs 传入）而非顶层
 * require('electron')：本模块可被单测直接 require，纯校验函数（fileUrlToPath /
 * imageMimeOf）无需 Electron 即可断言（与 themes.cjs、search.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')

/** 本地图片扩展名 → MIME（导出图片本地化的白名单，其余一律不读） */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** 单张本地图片读取上限（32MB，超限跳过而非撑爆导出内存） */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** 离屏窗口分区名：内存型（无 persist: 前缀，退出即清，不留磁盘足迹） */
const EXPORT_PARTITION = 'tmd-exporter'

/** 单个导出任务超时（3 分钟；超长文档分段截图 + 转换的兜底） */
const TASK_TIMEOUT_MS = 180000

/** 视口尺寸钳制范围（DIP） */
const MIN_DIP = 200
const MAX_DIP = 20000

/**
 * 离屏页专用 CSP：比主窗口放宽图片与网络来源——
 * 需加载文档内的远程图片（https）与 KaTeX 字体；脚本仍限 'self'（本地打包资源）。
 */
const EXPORT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: file: https: http:; font-src 'self' data: file:; " +
  "connect-src 'self' data: blob: https: http:"

/**
 * file:// URL → 本地绝对路径。
 * 兼容 file:///Users/a.png（POSIX）与 file:///E:/a.png（Windows 盘符）；
 * 非 file: 协议、相对路径、无法解析的转义一律返回 null。
 * @param {unknown} fileUrl
 * @returns {string | null}
 */
function fileUrlToPath(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return null
  let p = fileUrl.slice('file://'.length)
  // Windows 盘符形态：file:///E:/a.png → /E:/a.png 去掉多余前导斜杠
  if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1)
  try {
    p = decodeURIComponent(p)
  } catch {
    return null // 非法百分号转义：不猜，直接拒绝
  }
  const isPosixAbsolute = p.startsWith('/')
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(p)
  return isPosixAbsolute || isWindowsAbsolute ? p : null
}

/**
 * 由扩展名取图片 MIME（白名单外返回 null）。
 * @param {string} filePath
 * @returns {string | null}
 */
function imageMimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, ext)
    ? IMAGE_MIME[/** @type {keyof typeof IMAGE_MIME} */ (ext)]
    : null
}

/**
 * 读取本地图片为 data URI（白名单扩展名 + 大小上限），失败一律返回 null。
 * 离屏页无 file: 读取权限，本地图片经此原语内联。
 * @param {unknown} fileUrl
 * @returns {Promise<string | null>}
 */
async function readImageAsDataUri(fileUrl) {
  const filePath = fileUrlToPath(fileUrl)
  if (!filePath) return null
  const mime = imageMimeOf(filePath)
  if (!mime) return null
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null
    const buf = await fs.readFile(filePath)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null // 文件不存在 / 无权限：留 alt 文本，不阻断整篇导出
  }
}

/**
 * 串行任务队列：导出低频，同一时刻只跑一个任务（隐藏窗口与分区复用）。
 * 前序任务失败不阻塞后续（chain 吞掉异常后继续）。
 * @template T
 * @returns {(task: () => Promise<T>) => Promise<T>}
 */
function createQueue() {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()
  return (task) => {
    const run = chain.then(task, task)
    chain = run.catch(() => {})
    return run
  }
}

/**
 * 创建离屏导出服务实例。
 *
 * @param {object} deps 由 main.cjs 注入的 Electron 能力（便于脱壳单测）
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {typeof import('electron').session} deps.session
 * @param {typeof import('electron').ipcMain} deps.ipcMain
 * @param {typeof import('electron').dialog} deps.dialog
 * @param {import('../src/native.ts').IpcChannels} deps.IPC
 * @param {string | undefined} deps.rendererUrl 开发服务器地址（生产为 undefined）
 * @param {() => import('electron').BrowserWindow | null} deps.getParentWindow 保存对话框的父窗口
 */
function createExporter(deps) {
  const { BrowserWindow, session, ipcMain, dialog, IPC, rendererUrl, getParentWindow } = deps

  /** @type {import('electron').BrowserWindow | null} */
  let win = null
  /** @type {Promise<void> | null} 窗口首次加载完成的等待（单例复用） */
  let loaded = null
  /** @type {{ resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void } | null} */
  let pending = null
  const enqueue = createQueue()

  /** 关闭并释放隐藏窗口（窗口崩溃 / 应用退出时调用） */
  function destroyWindow() {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
    loaded = null
  }

  /**
   * 取（必要时创建）隐藏导出窗口。
   * 窗口属性要点：
   * - show:false 不打扰用户；backgroundThrottling:false 保证隐藏时仍按帧渲染
   * - useContentSize:true 使 setContentSize 的语义与截图尺寸一致
   * - enableLargerThanScreen:true 允许视口高于屏幕（长图分段截取需要）
   * @returns {Promise<import('electron').BrowserWindow>}
   */
  function ensureWindow() {
    if (win && !win.isDestroyed()) {
      return loaded
        ? loaded.then(() => /** @type {import('electron').BrowserWindow} */ (win))
        : Promise.resolve(win)
    }
    win = new BrowserWindow({
      show: false,
      width: 960,
      height: 1200,
      useContentSize: true,
      enableLargerThanScreen: true,
      // 隐藏窗口不应进入任务栏/切换器，也不该抢焦点
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'exporter-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // preload 需 require 本地 ./ipc.cjs（通道名常量），与主窗口同理
        sandbox: false,
        partition: EXPORT_PARTITION,
        backgroundThrottling: false,
      },
    })
    const target = win
    // 离屏页只加载一次导出入口，不随任务变化（复用 mermaid/katex 的加载成本）
    loaded = new Promise((resolve) => {
      target.webContents.once('did-finish-load', () => resolve())
    })
    target.webContents.on('will-navigate', (event) => event.preventDefault())
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 渲染进程崩溃：释放等待中的任务，下次导出重建窗口
    target.webContents.on('render-process-gone', (_event, details) => {
      if (pending) {
        pending.reject(new Error(`导出窗口异常退出: ${details.reason}`))
        pending = null
      }
      destroyWindow()
    })
    if (rendererUrl) {
      target.loadURL(`${rendererUrl}/export-renderer.html`)
    } else {
      target.loadFile(path.join(__dirname, '../dist/export-renderer.html'))
    }
    return loaded.then(() => target)
  }

  /**
   * 等待渲染进程提交一帧（两次 rAF + 短延时）：
   * setContentSize 后的重排与重绘需要落地，否则截到旧帧。
   * @param {import('electron').WebContents} wc
   */
  async function settle(wc) {
    try {
      await wc.executeJavaScript(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))',
        true,
      )
    } catch {
      // 页面尚未就绪或已销毁：退回固定延时，仍给一次机会
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  /** 加载完成后立即注册分区级 CSP 与导航拦截 */
  function setupSession() {
    const exportSession = session.fromPartition(EXPORT_PARTITION)
    exportSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [EXPORT_CSP] },
      })
    })
  }

  /**
   * 把任务下发给离屏页并等待结果字节。
   * @param {unknown} task
   * @returns {Promise<Uint8Array>}
   */
  async function dispatch(task) {
    const target = await ensureWindow()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null
        reject(new Error('导出超时'))
      }, TASK_TIMEOUT_MS)
      pending = {
        resolve: (bytes) => {
          clearTimeout(timer)
          resolve(bytes)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      target.webContents.send(IPC.exporterTask, task)
    })
  }

  /**
   * 一次完整导出：弹保存框（取消即返回，不启动离屏渲染）→ 离屏执行 → 写入目标文件。
   * @param {unknown} task
   * @param {{ defaultName: string, filters: { name: string, extensions: string[] }[] }} options
   * @returns {Promise<{ path: string, name: string } | null>}
   */
  async function run(task, options) {
    const parent = getParentWindow()
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const bytes = await dispatch(task)
    await fs.writeFile(result.filePath, Buffer.from(bytes))
    return { path: result.filePath, name: path.basename(result.filePath) }
  }

  /**
   * 注册三条服务侧通道：
   * - exportRun：主窗口发起（保存框 + 队列 + 落盘）
   * - exporterDone：离屏页回传结果字节
   * - exporterCapture / exporterReadImage：离屏页调用的原语
   */
  function register() {
    setupSession()

    /** @param {unknown} _event @param {{ task: unknown, defaultName: string, filters: { name: string, extensions: string[] }[] }} options */
    ipcMain.handle(IPC.exportRun, async (_event, options) => {
      const { task, defaultName, filters } = options
      return enqueue(() => run(task, { defaultName, filters }))
    })

    // 仅接受来自导出窗口自身的回传（防御其他渲染层伪造结果）
    /**
     * @param {import('electron').IpcMainInvokeEvent} event
     * @param {{ ok: boolean, bytes?: Uint8Array, error?: string }} payload
     */
    ipcMain.handle(IPC.exporterDone, async (event, payload) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return
      const waiter = pending
      pending = null
      if (!waiter) return
      if (payload && payload.ok && payload.bytes) {
        waiter.resolve(payload.bytes)
      } else {
        waiter.reject(new Error(payload && payload.error ? payload.error : '导出失败'))
      }
    })

    /**
     * 原语：截图（两种模式）。
     * - 视口模式：按 zoom 归一后的尺寸设置窗口内容尺寸，等一帧后截取整个视口（长图分段）
     * - 区域模式：不改窗口尺寸，截取当前视口内的一块矩形（Word 公式栅格化）
     * @param {import('electron').IpcMainInvokeEvent} event
     * @param {{ widthCss?: number, heightCss?: number, region?: { x: number, y: number, width: number, height: number }, zoom: number }} req
     */
    ipcMain.handle(IPC.exporterCapture, async (event, req) => {
      const target = BrowserWindow.fromWebContents(event.sender)
      if (!target || target.isDestroyed() || !req) return null
      const zoom = Number(req.zoom) > 0 ? Number(req.zoom) : 1
      // 页面 CSS px 与窗口 DIP 的换算：1 个（zoom 生效后的）CSS px = zoom 个 DIP
      /** @param {number} v @returns {number} */
      const clampDip = (v) => Math.max(MIN_DIP, Math.min(MAX_DIP, Math.round(v)))
      /** @type {{ x: number, y: number, width: number, height: number } | undefined} */
      let rect
      if (req.region) {
        const { x, y, width, height } = req.region
        if (!(width > 0) || !(height > 0)) return null
        rect = {
          x: Math.max(0, Math.round(x * zoom)),
          y: Math.max(0, Math.round(y * zoom)),
          width: Math.max(1, Math.round(width * zoom)),
          height: Math.max(1, Math.round(height * zoom)),
        }
      } else {
        const widthCss = Number(req.widthCss) > 0 ? Number(req.widthCss) : 0
        const heightCss = Number(req.heightCss) > 0 ? Number(req.heightCss) : 0
        if (!widthCss || !heightCss) return null
        target.setContentSize(clampDip(widthCss * zoom), clampDip(heightCss * zoom))
      }
      await settle(target.webContents)
      const image = rect
        ? await target.webContents.capturePage(rect)
        : await target.webContents.capturePage()
      const size = image.getSize()
      const refCss = rect ? rect.width / zoom : Number(req.widthCss)
      return {
        dataUrl: image.toDataURL(),
        physicalWidth: size.width,
        physicalHeight: size.height,
        // 实际物理像素 / 请求的 CSS 像素（= zoom × 设备像素比），供离屏页校验清晰度
        pixelRatio: refCss > 0 ? size.width / refCss : 1,
      }
    })

    /** @param {unknown} _event @param {unknown} fileUrl */
    ipcMain.handle(IPC.exporterReadImage, async (_event, fileUrl) => readImageAsDataUri(fileUrl))
  }

  return { register, run, destroyWindow }
}

module.exports = { createExporter, fileUrlToPath, imageMimeOf, readImageAsDataUri }
