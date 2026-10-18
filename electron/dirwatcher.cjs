/**
 * 侧边栏目录的外部变化监视（纯 Node 模块，不依赖 Electron，可脱壳单测——
 * 与 filewatcher.cjs / history.cjs 同构）。
 *
 * 渲染层经 tmd:watch-dirs 全量同步「侧边栏已加载的目录集合」（挂载根 +
 * 展开过的各级子目录），本模块 diff 后对新增目录挂 fs.watch、对移除目录
 * 关闭；非递归监视只关心直接子项的增删改名（一层），子目录内部的进一步
 * 变化由它自己的 watcher（渲染层展开后同步进来）负责。
 *
 * 触发时按目录防抖合并后回调 onChange(dir)——Windows / macOS 上一次
 * 操作常派发多个事件。文件内容变化不归本模块（打开文件由 filewatcher.cjs
 * 监视）；目录被删除 / 改名后 watcher 失效，等渲染层下次 sync 重新对齐。
 *
 * @author chiangyang
 */
const { watch } = require('node:fs')

/** 同一目录事件的防抖窗口：一次外部操作（含临时文件 + rename）只刷新一次 */
const DEBOUNCE_MS = 200
/** 监视数量上限：等于侧边栏已加载目录数，兜底防御渲染层异常载荷 */
const MAX_WATCHERS = 256

/**
 * @param {{ onChange: (dir: string) => void }} deps
 */
function createDirWatcher({ onChange }) {
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  /** 目录 → 防抖定时器 */
  const pending = new Map()
  let closed = false

  /** @param {string} dir */
  function schedule(dir) {
    if (pending.has(dir)) return
    const timer = setTimeout(() => {
      pending.delete(dir)
      if (!closed) onChange(dir)
    }, DEBOUNCE_MS)
    pending.set(dir, timer)
  }

  /** @param {string} dir */
  function attach(dir) {
    if (closed || watchers.has(dir)) return
    try {
      const w = watch(dir, () => schedule(dir))
      // 目录被删除 / 权限变化：关闭该 watcher 并清理（尽力而为的加成能力）
      w.on('error', () => detach(dir))
      watchers.set(dir, w)
    } catch {
      // 目录已不存在等：静默，绝不反过来影响侧边栏渲染主流程
    }
  }

  /** @param {string} dir */
  function detach(dir) {
    const w = watchers.get(dir)
    if (w) {
      w.close()
      watchers.delete(dir)
    }
    const timer = pending.get(dir)
    if (timer) {
      clearTimeout(timer)
      pending.delete(dir)
    }
  }

  /**
   * 全量同步监视集合（渲染层每次侧边栏重渲染后调用）：差量增删。
   * @param {unknown} paths
   */
  function sync(paths) {
    if (closed || !Array.isArray(paths)) return
    const want = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))].slice(
      0,
      MAX_WATCHERS,
    )
    for (const p of want) attach(p)
    for (const p of [...watchers.keys()]) {
      if (!want.includes(p)) detach(p)
    }
  }

  function stop() {
    closed = true
    for (const p of [...watchers.keys()]) detach(p)
  }

  // 测试观察口（主进程不使用 size）
  return { sync, stop, size: () => watchers.size, DEBOUNCE_MS }
}

module.exports = { createDirWatcher, DEBOUNCE_MS, MAX_WATCHERS }
