/**
 * 本地历史版本（文件快照）：写盘覆盖前把旧内容存档，仅提供人工恢复入口。
 *
 * 设计原则：
 * - 纯 Node 模块（不依赖 Electron），与 logger.cjs / themes.cjs / search.cjs 同构：
 *   主进程只做装配（在 saveFile 写盘前调用 writeSnapshot），
 *   哈希/去重/剪枝/列举等纯逻辑可被单测直接 require 验证
 * - 只存本地磁盘，不发起任何网络请求，也不感知文档内容之外的信息
 * - 失败静默降级：快照故障绝不能反过来阻断用户的保存动作
 *
 * 目录约定（与 ~/.tmd/themes、~/.tmd/logs 同级，跨安装/升级保留）：
 * - ~/.tmd/history/<key>/index.json	该源文件的元信息与快照清单（最新在前）
 * - ~/.tmd/history/<key>/<id>.md		快照正文，id 为本地时间戳，按文件名即有序
 *
 * key 取源文件绝对路径的 sha1 前 16 位——路径本身不能作目录名（含分隔符、
 * 长度与大小写问题）。目录自描述（index 里存源文件路径与文件名），故无需
 * 全局索引；剪枝一次遍历同时完成「单文件数量上限」与「全局容量上限」。
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

/** 每个源文件保留的最多快照数（超出按时间最旧优先删除） */
const HISTORY_MAX_PER_FILE = 50
/** 历史目录总容量上限（字节）；超出后跨文件按时间最旧优先删除 */
const HISTORY_MAX_TOTAL_BYTES = 200 * 1024 * 1024
/** 快照 id 形状：YYYYMMDD-HHmmss，同秒冲突时追加 -2、-3… */
const ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/

/**
 * 历史版本根目录绝对路径：~/.tmd/history。
 * @param {string} home - tmdHome() 返回的资产根目录
 * @returns {string}
 */
function historyDir(home) {
  return path.join(home, '.tmd', 'history')
}

/**
 * 源文件路径 → 快照目录名（sha1 前 16 位）。
 * Windows / macOS 文件系统默认大小写不敏感，统一小写可避免同一文件因大小写
 * 差异分裂成两份历史；Linux 大小写敏感，保持原样以免误合并 A.md 与 a.md。
 * @param {string} filePath
 * @returns {string}
 */
function snapshotKey(filePath) {
  const resolved = path.resolve(filePath)
  const normalized = process.platform === 'linux' ? resolved : resolved.toLowerCase()
  return crypto.createHash('sha1').update(normalized, 'utf-8').digest('hex').slice(0, 16)
}

/**
 * 某个源文件对应的快照目录绝对路径。
 * @param {string} root - historyDir() 返回值
 * @param {string} filePath
 * @returns {string}
 */
function snapshotDir(root, filePath) {
  return path.join(root, snapshotKey(filePath))
}

/**
 * 本地时间戳串 YYYYMMDD-HHmmss（快照 id 前缀，按名即可排序）。
 * @param {Date} date
 * @returns {string}
 */
function stampId(date) {
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * id 合法性校验：读取快照前必查，杜绝 `../` 之类的目录穿越。
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

/**
 * 内容指纹（去重用）：自动保存每 5 秒写盘一次，内容未变的重复快照必须丢弃。
 * @param {string} content
 * @returns {string}
 */
function contentHash(content) {
  return crypto.createHash('sha1').update(content, 'utf-8').digest('hex')
}

/**
 * 读取某快照目录的 index.json；缺失视为无历史（返回 null）。
 * 内容不可用（JSON 非法或结构异常）时先把原文件改名留档再返回 null——
 * 否则调用方的 writeSnapshot 会以空列表为基底覆盖，旧快照的元信息永久丢失
 * （正文 .md 仍在磁盘，但列表再也列不出来）。
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {Promise<{ path: string, name: string, snapshots: { id: string, ts: string, size: number, hash: string }[] } | null>}
 */
async function readIndex(dir, fsImpl) {
  const file = path.join(dir, 'index.json')
  let raw
  try {
    raw = await fsImpl.readFile(file, 'utf-8')
  } catch {
    return null
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed.path === 'string' && Array.isArray(parsed.snapshots)) return parsed
  await fsImpl.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
  return null
}

/**
 * 写入 index.json（失败静默：历史记录不值得打扰用户）。
 * 走临时文件 + 原子替换：直接覆盖时写入中断会留下截断的 JSON，
 * 整份历史清单将不可读。
 * @param {string} dir
 * @param {{ path: string, name: string, snapshots: unknown[] }} index
 * @param {typeof fs} fsImpl
 */
async function writeIndex(dir, index, fsImpl) {
  const file = path.join(dir, 'index.json')
  const tmp = `${file}.tmp`
  try {
    await fsImpl.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8')
    await fsImpl.rename(tmp, file)
  } catch {
    await fsImpl.rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * 删除单个快照正文文件（force 静默缺失）。
 * @param {string} dir
 * @param {string} id
 * @param {typeof fs} fsImpl
 */
async function removeSnapshot(dir, id, fsImpl) {
  // id 来自 index.json（可能被外部改动）：删除前再校验一次，杜绝目录穿越
  if (!isValidId(id)) return
  await fsImpl.rm(path.join(dir, `${id}.md`), { force: true }).catch(() => {})
}

/**
 * 生成不与既有快照冲突的 id（同一秒内多次保存时追加序号）。
 * @param {Set<string>} used
 * @param {Date} now
 * @returns {string}
 */
function uniqueId(used, now) {
  const base = stampId(now)
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * 记录一条快照（在写盘覆盖之前调用，content 为即将被覆盖的旧内容）。
 *
 * 跳过规则：空内容不存（无恢复价值）；与最新一条内容相同不存（自动保存
 * 每 5 秒写盘，靠内容指纹挡住重复）。写入后立即剪枝。
 *
 * @param {string} root - historyDir() 返回值
 * @param {{ path: string, name: string, content: string, now?: Date }} entry
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {Promise<{ saved: boolean, id?: string, reason?: string }>}
 */
async function writeSnapshot(root, entry, options = {}) {
  const fsImpl = options.fsImpl || fs
  const { path: filePath, name, content } = entry
  const now = entry.now || new Date()
  if (typeof filePath !== 'string' || !filePath) return { saved: false, reason: 'no-path' }
  if (typeof content !== 'string' || content === '') return { saved: false, reason: 'empty' }

  const dir = snapshotDir(root, filePath)
  const existing = await readIndex(dir, fsImpl)
  const hash = contentHash(content)
  const snapshots = existing ? existing.snapshots : []
  if (snapshots[0] && snapshots[0].hash === hash) return { saved: false, reason: 'duplicate' }

  const id = uniqueId(new Set(snapshots.map((s) => s.id)), now)
  try {
    await fsImpl.mkdir(dir, { recursive: true })
    await fsImpl.writeFile(path.join(dir, `${id}.md`), content, 'utf-8')
  } catch {
    return { saved: false, reason: 'write-failed' }
  }

  // 源文件可能被重命名 / 移动，index 里的路径与文件名以最新一次为准
  const next = {
    path: filePath,
    name: typeof name === 'string' && name ? name : path.basename(filePath),
    snapshots: [
      { id, ts: now.toISOString(), size: Buffer.byteLength(content, 'utf-8'), hash },
      ...snapshots,
    ],
  }
  await writeIndex(dir, next, fsImpl)
  await pruneHistory(root, { fsImpl })
  return { saved: true, id }
}

/**
 * 列出某源文件的全部快照（最新在前）。无历史时返回 null。
 * @param {string} root
 * @param {string} filePath
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {Promise<{ path: string, name: string, snapshots: { id: string, ts: string, size: number }[] } | null>}
 */
async function listSnapshots(root, filePath, options = {}) {
  const fsImpl = options.fsImpl || fs
  if (typeof filePath !== 'string' || !filePath) return null
  const index = await readIndex(snapshotDir(root, filePath), fsImpl)
  if (!index || index.snapshots.length === 0) return null
  return {
    path: index.path,
    name: index.name,
    // hash 是内部去重用的，不外传
    snapshots: index.snapshots.map((s) => ({ id: s.id, ts: s.ts, size: s.size })),
  }
}

/**
 * 读取单条快照正文。id 非法或文件缺失时返回 null。
 * @param {string} root
 * @param {string} filePath
 * @param {string} id
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {Promise<{ id: string, ts: string, content: string } | null>}
 */
async function readSnapshot(root, filePath, id, options = {}) {
  const fsImpl = options.fsImpl || fs
  if (!isValidId(id) || typeof filePath !== 'string' || !filePath) return null
  const dir = snapshotDir(root, filePath)
  try {
    const content = await fsImpl.readFile(path.join(dir, `${id}.md`), 'utf-8')
    const index = await readIndex(dir, fsImpl)
    const meta = index?.snapshots.find((s) => s.id === id)
    return { id, ts: meta?.ts || '', content }
  } catch {
    return null
  }
}

/**
 * 剪枝：一次遍历同时完成两层上限。
 * 1. 单文件数量上限：每个源文件仅保留最新 HISTORY_MAX_PER_FILE 条
 * 2. 全局容量上限：总量超 HISTORY_MAX_TOTAL_BYTES 时，跨文件按时间最旧优先删
 * @param {string} root
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {Promise<{ removed: number, bytes: number }>}
 */
async function pruneHistory(root, options = {}) {
  const fsImpl = options.fsImpl || fs
  /** @type {string[]} */
  let keys
  try {
    keys = await fsImpl.readdir(root)
  } catch {
    return { removed: 0, bytes: 0 } // 历史目录尚不存在
  }

  let removed = 0
  let total = 0
  /** @type {{ dir: string, index: { path: string, name: string, snapshots: { id: string, ts: string, size: number, hash: string }[] } }[]} */
  const all = []
  for (const key of keys) {
    const dir = path.join(root, key)
    const st = await fsImpl.stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) continue
    const index = await readIndex(dir, fsImpl)
    if (!index) continue

    const keep = index.snapshots.slice(0, HISTORY_MAX_PER_FILE)
    const drop = index.snapshots.slice(HISTORY_MAX_PER_FILE)
    for (const s of drop) {
      await removeSnapshot(dir, s.id, fsImpl)
      removed++
    }
    if (drop.length > 0) {
      index.snapshots = keep
      await writeIndex(dir, index, fsImpl)
    }
    for (const s of keep) total += Number(s.size) || 0
    all.push({ dir, index })
  }

  if (total <= HISTORY_MAX_TOTAL_BYTES) return { removed, bytes: total }

  // 容量剪：跨文件扁平化后按时间从旧到新删，直到回落上限之内
  const flat = []
  for (const entry of all) {
    for (const snap of entry.index.snapshots) flat.push({ entry, snap })
  }
  flat.sort((a, b) => String(a.snap.ts).localeCompare(String(b.snap.ts)))
  /** @type {Set<{ dir: string, index: { path: string, name: string, snapshots: { id: string, ts: string, size: number, hash: string }[] } }>} */
  const touched = new Set()
  for (const { entry, snap } of flat) {
    if (total <= HISTORY_MAX_TOTAL_BYTES) break
    await removeSnapshot(entry.dir, snap.id, fsImpl)
    removed++
    total -= Number(snap.size) || 0
    entry.index.snapshots = entry.index.snapshots.filter((s) => s.id !== snap.id)
    touched.add(entry)
  }
  for (const entry of touched) await writeIndex(entry.dir, entry.index, fsImpl)

  return { removed, bytes: Math.max(total, 0) }
}

module.exports = {
  HISTORY_MAX_PER_FILE,
  HISTORY_MAX_TOTAL_BYTES,
  historyDir,
  snapshotKey,
  snapshotDir,
  stampId,
  isValidId,
  contentHash,
  uniqueId,
  writeSnapshot,
  listSnapshots,
  readSnapshot,
  pruneHistory,
}
