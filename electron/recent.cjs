/**
 * 最近文件（镜像渲染层 localStorage 列表，权威仍在渲染层）。
 *
 * 主进程只保留镜像用于原生菜单「打开最近文件」子菜单，并负责系统级
 * 最近文档注册（Windows Jump List / macOS Dock 菜单 / Linux recent）。
 *
 * 依赖注入（app/ipcMain 由 main.cjs 传入）而非顶层 require('electron')：
 * 本模块可被单测直接 require（与 exporter.cjs、themes.cjs 同构）。
 *
 * @author chiangyang
 */

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

/**
 * 创建最近文件服务。
 * @param {{
 *   app: import('electron').App,
 *   ipcMain: import('electron').IpcMain,
 *   IPC: typeof import('./ipc.cjs'),
 *   onMenuChange: () => void,
 * }} deps onMenuChange：镜像列表变化后重建应用菜单（main.cjs 的 buildMenu）
 */
function createRecent({ app, ipcMain, IPC, onMenuChange }) {
  /** 最近文件（最新在前，与渲染层 tmd:recent 同序同长，渲染层经 IPC 同步） */
  /** @type {import('../src/native.ts').RecentMenuEntry[]} */
  let recentDocs = []

  /** 当前镜像列表（buildMenu 构建「打开最近文件」子菜单用） */
  /** @returns {import('../src/native.ts').RecentMenuEntry[]} */
  function getRecents() {
    return recentDocs
  }

  /** 注册 recentSync / recentAdd / recentClear / recentRemove 四条 IPC */
  function register() {
    // 启动全量同步：仅重建菜单，不触碰系统最近文档（避免启动顺序误清/误加）
    /** @param {unknown} _event @param {unknown} entries */
    ipcMain.on(IPC.recentSync, (_event, entries) => {
      recentDocs = normalizeRecent(entries)
      onMenuChange()
    })

    // 新增/打开：注册到系统最近文档（Windows Jump List / macOS Dock 菜单 / Linux recent），
    // 镜像列表去重置顶（限量 8）后重建菜单
    /** @param {unknown} _event @param {unknown} entry */
    ipcMain.on(IPC.recentAdd, (_event, entry) => {
      const [first] = normalizeRecent([entry])
      if (!first) return
      app.addRecentDocument(first.path)
      recentDocs = [first, ...recentDocs.filter((r) => r.path !== first.path)].slice(0, 8)
      onMenuChange()
    })

    // 清空：系统最近文档与镜像列表一并清空
    ipcMain.on(IPC.recentClear, () => {
      app.clearRecentDocuments()
      recentDocs = []
      onMenuChange()
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
      onMenuChange()
    })
  }

  return { getRecents, register }
}

module.exports = { createRecent, normalizeRecent }
