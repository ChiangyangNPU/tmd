/**
 * 壳层持久化状态（shell-state.json）。
 *
 * 存主题来源（themeSource）与窗口状态（winState：尺寸/位置/最大化标记），
 * 存于 userData/shell-state.json（随应用卸载清理）。启动时在 createWindow()
 * 之前恢复，使两平台的启动外观与窗口几何从第一帧起就正确——纯统一实现，
 * 不含平台分支。
 *
 * 依赖注入（app/screen 由 main.cjs 传入）而非顶层 require('electron')：
 * 本模块可被单测直接 require（与 themes.cjs、search.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')

/**
 * 创建壳层状态服务。
 * @param {{ app: import('electron').App, screen: import('electron').Screen }} deps
 */
function createShellState({ app, screen }) {
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
    shellStateQueue = shellStateQueue
      .then(() => {
        const state = { ...readShellState(), ...patch }
        const tmp = `${shellStateFile}.tmp`
        // 走临时文件 + 原子替换：直接覆盖时进程中断会留下截断的 JSON，
        // 下次启动 readShellState 解析失败即丢失全部壳层状态
        return fs
          .writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
          .then(() => fs.rename(tmp, shellStateFile))
      })
      .catch(() => {
        // 写失败静默：壳层状态只影响下次启动的主题外观，清理残留临时文件
        fs.unlink(`${shellStateFile}.tmp`).catch(() => {})
      })
  }

  /**
   * 归一化持久化的窗口状态：宽高钳制到最小值；仅当左上角落在某个屏幕的
   * 工作区内才恢复位置（显示器拔插/换机后旧坐标可能悬空），否则交给系统
   * 默认摆放。无记录或字段不合法返回 null。
   * @returns {{ width: number, height: number, x?: number, y?: number, maximized?: boolean } | null}
   */
  function restoreWinState() {
    const s = /** @type {Record<string, unknown> | null | undefined} */ (readShellState().winState)
    if (!s || typeof s !== 'object') return null
    const num = (/** @type {unknown} */ v) =>
      Number.isFinite(Number(v)) ? Math.round(Number(v)) : null
    const width = num(s.width)
    const height = num(s.height)
    if (!width || !height) return null
    /** @type {{ width: number, height: number, x?: number, y?: number, maximized?: boolean }} */
    const out = {
      width: Math.max(860, width),
      height: Math.max(560, height),
    }
    const x = num(s.x)
    const y = num(s.y)
    if (x == null || y == null) return out
    const onScreen = screen
      .getAllDisplays()
      .some(
        (d) =>
          x >= d.workArea.x &&
          x < d.workArea.x + d.workArea.width &&
          y >= d.workArea.y &&
          y < d.workArea.y + d.workArea.height,
      )
    if (onScreen) {
      out.x = x
      out.y = y
    }
    if (s.maximized === true) out.maximized = true
    return out
  }

  /**
   * 窗口几何持久化：移动/缩放防抖 500ms 异步落盘（高频事件不刷盘），
   * 最大化/还原即时记录；关闭时同步落盘兜底——退出路径上异步写链不保证
   * 执行完。尺寸取 getNormalBounds()：最大化时记录的仍是还原后的几何，
   * 配合 maximized 标记下次启动先最大化再显示，无二次跳变。
   * @param {import('electron').BrowserWindow} win
   */
  function wireWinStatePersistence(win) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const patch = () => ({
      winState: { ...win.getNormalBounds(), maximized: win.isMaximized() },
    })
    const debounced = () => {
      clearTimeout(timer)
      timer = setTimeout(() => saveShellState(patch()), 500)
    }
    win.on('resize', debounced)
    win.on('move', debounced)
    win.on('maximize', () => saveShellState(patch()))
    win.on('unmaximize', () => saveShellState(patch()))
    win.on('close', () => {
      clearTimeout(timer)
      if (win.isDestroyed()) return
      try {
        const state = { ...readShellState(), ...patch() }
        const tmp = `${shellStateFile}.tmp`
        fsSync.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
        fsSync.renameSync(tmp, shellStateFile)
      } catch {
        // 同步兜底失败静默：还有防抖路径的异步写，最坏丢最后一次微调
      }
    })
  }

  return { readShellState, saveShellState, restoreWinState, wireWinStatePersistence }
}

module.exports = { createShellState }
