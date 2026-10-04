/**
 * 打开文件的外部修改监视（纯 Node 模块，不依赖 Electron，可脱壳单测——
 * 与 history.cjs / search.cjs / themes.cjs 同构）。
 *
 * 渲染层经 tmd:watch-files 全量同步「当前打开的文件路径集合」，本模块
 * diff 后对新增路径挂 fs.watch、对移除路径关闭；文件事件按路径防抖合并，
 * 触发时读盘比对内容指纹（sha1），内容真的变了才回调 onEvent——自身保存
 * （主进程在 writeFile 后经 noteWrite 预先登记新指纹）与元数据噪声在主进程
 * 被过滤，渲染层只收到确定性的 change / unlink。
 *
 * 已知边界：
 * - 外部编辑器若用「临时文件 + rename」原子保存，原 FSWatcher 会随 inode
 *   失效停摆，故每次投递 change 后对同路径重建监视并以新指纹为基线；
 * - 文件被删除后若又在原路径重建，不会自动恢复跟踪，待渲染层下次
 *   sync（开关标签 / 保存）时按当前集合重新挂上。
 *
 * @author chiangyang
 */
const { watch } = require('node:fs')
const { createHash } = require('node:crypto')
const { readFile } = require('node:fs/promises')

/** 同一路径事件的防抖窗口：编辑器级连续写入（自动保存、外部逐块写）只查一次盘 */
const DEBOUNCE_MS = 200
/** 监视数量上限：正常等于打开的标签数，兜底防御渲染层异常载荷 */
const MAX_WATCHERS = 64

/** @param {string} text */
function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * @param {{ onEvent: (info: { path: string, kind: 'change' | 'unlink' }) => void }} deps
 */
function createFileWatcher({ onEvent }) {
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  /** 路径 → 最近一次已知的磁盘内容指纹（noteWrite 与投递 change 时推进） */
  const known = new Map()
  /** 路径 → 防抖定时器 */
  const pending = new Map()
  let closed = false

  /**
   * 读盘并比对指纹：ENOENT → unlink；指纹未变（含自身写入回声）→ 忽略；
   * 真变化 → 投递 change 并重建监视（rename 原子保存会让旧 watcher 失效）。
   * @param {string} path
   */
  async function inspect(path) {
    /** @type {string | undefined} */
    let content
    try {
      content = await readFile(path, 'utf-8')
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        if (known.has(path)) {
          known.delete(path)
          detach(path)
          onEvent({ path, kind: 'unlink' })
        }
        return
      }
      // 权限等瞬时错误：保留现状，等下一次事件再试（监视是尽力而为的加成能力）
      return
    }
    const hash = sha1(content)
    if (known.get(path) === hash) return
    onEvent({ path, kind: 'change' })
    // rename 替换后旧 FSWatcher 可能已随 inode 失效：关闭重建。
    // detach 会清指纹，重建后须重新落基线，保证自身写入的过滤继续生效
    detach(path)
    attach(path)
    known.set(path, hash)
  }

  /** @param {string} path */
  function schedule(path) {
    if (pending.has(path)) return
    const timer = setTimeout(() => {
      pending.delete(path)
      void inspect(path)
    }, DEBOUNCE_MS)
    pending.set(path, timer)
  }

  /** @param {string} path */
  function attach(path) {
    if (closed || watchers.has(path)) return
    try {
      const w = watch(path, () => schedule(path))
      watchers.set(path, w)
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        onEvent({ path, kind: 'unlink' })
      }
      // 其他失败静默：绝不反过来影响打开/保存主流程
    }
  }

  /** @param {string} path */
  function detach(path) {
    const w = watchers.get(path)
    if (w) {
      w.close()
      watchers.delete(path)
    }
    known.delete(path)
    const timer = pending.get(path)
    if (timer) {
      clearTimeout(timer)
      pending.delete(path)
    }
  }

  /**
   * 全量同步监视集合（渲染层每次开关标签 / 另存为后调用）：
   * 差量增删，已监视路径的指纹基线保持不动。
   * @param {unknown} paths
   */
  function sync(paths) {
    if (closed || !Array.isArray(paths)) return
    const want = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))].slice(
      0,
      MAX_WATCHERS,
    )
    for (const p of want) {
      if (watchers.has(p)) continue
      attach(p)
      // 建立内容基线：基线落定前到达的事件至多触发一次多余通知，
      // 渲染层有「内容与内存一致则跳过」的兜底，不会误重载
      readFile(p, 'utf-8').then(
        (content) => {
          if (watchers.has(p)) known.set(p, sha1(content))
        },
        () => {},
      )
    }
    for (const p of [...watchers.keys()]) {
      if (!want.includes(p)) detach(p)
    }
  }

  /**
   * 登记一次自身写入的新指纹：写盘已完成，紧随其后的文件事件按指纹
   * 比对自然被过滤。仅已监视路径登记，避免 Map 无界增长。
   * @param {string} path @param {string} content
   */
  function noteWrite(path, content) {
    if (watchers.has(path)) known.set(path, sha1(content))
  }

  function stop() {
    closed = true
    for (const p of [...watchers.keys()]) detach(p)
  }

  // 测试观察口（主进程不使用）
  return {
    sync,
    noteWrite,
    stop,
    size: () => watchers.size,
    /** @param {string} path */
    knownOf: (path) => known.get(path),
    DEBOUNCE_MS,
  }
}

module.exports = { createFileWatcher, sha1, DEBOUNCE_MS, MAX_WATCHERS }
