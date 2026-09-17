/**
 * 本地日志与崩溃线索：~/.tmd/logs 下按天滚动的 JSONL 日志，
 * 以及 ~/.tmd/crash-dumps 下 crashpad minidump 的「已见清单」管理。
 *
 * 设计原则：
 * - 纯 Node 模块（不依赖 Electron），与 themes.cjs / search.cjs 同构：
 *   主进程只做装配，入参校验/轮转/截断/去重等纯逻辑可被单测直接 require 验证
 * - 零遥传：本模块只读写本地磁盘，不发起任何网络请求；
 *   原生 minidump 由 crashReporter 以 upload:false 配置写入 crash-dumps 目录
 * - 日志是给人排查问题用的：只记 message/stack/代码位置，不记任何文档内容
 * - 写盘失败静默吞掉（日志故障不能反过来打挂应用，也不能递归触发异常钩子）
 *
 * 目录约定（与 ~/.tmd/themes 同级，跨安装/升级保留，方便用户取出反馈）：
 * - ~/.tmd/logs/app-YYYY-MM-DD.jsonl	应用日志（每行一条 JSON）
 * - ~/.tmd/logs/.seen-dumps			已在日志中登记过的 minidump 文件名清单
 * - ~/.tmd/crash-dumps/				crashReporter 写入的原生崩溃 minidump
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

/** 日志保留天数（mtime 早于此刻 7 天的日文件删除） */
const LOG_RETENTION_DAYS = 7
/** 日志文件数上限（清理超龄文件后仍多于该数时，从最旧开始删） */
const LOG_RETENTION_FILES = 10
/** 单个文本字段（message/stack）长度上限，超出截断 */
const FIELD_MAX = 4096
/** 同 source+message 去重窗口：窗口内重复仅计数、不重复落盘 */
const DEDUP_WINDOW_MS = 60 * 1000
/** 允许记录的日志级别（IPC 入参不接受级别，渲染层上报固定为 error） */
const LEVELS = ['error', 'warn']
/** 允许记录的来源标识 */
const SOURCES = ['main', 'renderer', 'child-process', 'native-crash']

/**
 * TMD 用户资产根目录。
 * TMD_HOME_DIR 环境变量可重定位根目录（E2E 隔离测试 / 便携版）；
 * 未设置或为空时回落到用户主目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
function tmdHome(env = process.env, home = os.homedir()) {
  const custom = env.TMD_HOME_DIR
  return typeof custom === 'string' && custom ? custom : home
}

/**
 * 日志目录绝对路径：~/.tmd/logs。
 * @param {string} home - tmdHome() 返回的资产根目录
 * @returns {string}
 */
function logsDir(home) {
  return path.join(home, '.tmd', 'logs')
}

/**
 * 原生崩溃 minidump 目录绝对路径：~/.tmd/crash-dumps。
 * @param {string} home
 * @returns {string}
 */
function crashDumpsDir(home) {
  return path.join(home, '.tmd', 'crash-dumps')
}

/**
 * 本地日期串 YYYY-MM-DD（按运行机器本地时区，日文件按本地天滚动）。
 * @param {Date} [date]
 * @returns {string}
 */
function localDate(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 指定日期对应的日志文件名。
 * @param {string} date - localDate() 产出的日期串
 * @returns {string}
 */
function logFileName(date) {
  return `app-${date}.jsonl`
}

/**
 * 轮转决策：给定现有日志文件清单，返回应当删除的文件名。
 * 先剔除超龄文件，剩余按 mtime 从旧到新排序，超过文件数上限的最旧一批删除。
 * @param {{ name: string, mtime: number | Date }[]} entries
 * @param {Date} [now]
 * @returns {string[]}
 */
function pruneLogFiles(entries, now = new Date()) {
  const cutoff = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  // 超龄文件全部删除；未超龄的再按 mtime 从旧到新，超出数量上限的最旧一批一并删除
  const aged = entries.filter((e) => Number(e.mtime) < cutoff).map((e) => e.name)
  const fresh = entries
    .filter((e) => Number(e.mtime) >= cutoff)
    .sort((a, b) => Number(a.mtime) - Number(b.mtime))
  const excess = Math.max(0, fresh.length - LOG_RETENTION_FILES)
  return [...aged, ...fresh.slice(0, excess).map((e) => e.name)]
}

/**
 * 文本字段截断：非字符串安全字符串化，超 FIELD_MAX 裁剪并附截断标记。
 * @param {unknown} value
 * @returns {string}
 */
function truncateField(value) {
  const str = typeof value === 'string' ? value : String(value ?? '')
  return str.length > FIELD_MAX ? `${str.slice(0, FIELD_MAX)}…[truncated]` : str
}

/**
 * 组装一条合法日志记录（白名单字段 + 级别/来源校验 + 长度截断）。
 * 非法级别/来源或缺 message 时返回 null（调用方据此丢弃 IPC 垃圾入参）。
 * @param {string} level
 * @param {string} source
 * @param {unknown} message
 * @param {string} [stack]
 * @param {{ filename?: string, lineno?: number, colno?: number, reason?: string, exitCode?: number, dump?: string }} [meta]
 * @param {Date} [now]
 * @returns {Record<string, unknown> | null}
 */
function buildEntry(level, source, message, stack, meta = {}, now = new Date()) {
  if (!LEVELS.includes(level) || !SOURCES.includes(source)) return null
  if (message === undefined || message === null || message === '') return null
  /** @type {Record<string, unknown>} */
  const entry = {
    ts: now.toISOString(),
    level,
    source,
    message: truncateField(message),
  }
  if (typeof stack === 'string' && stack) entry.stack = truncateField(stack)
  if (typeof meta.filename === 'string' && meta.filename)
    entry.filename = truncateField(meta.filename)
  if (typeof meta.lineno === 'number' && Number.isFinite(meta.lineno)) entry.lineno = meta.lineno
  if (typeof meta.colno === 'number' && Number.isFinite(meta.colno)) entry.colno = meta.colno
  // 子进程崩溃 / 原生崩溃登记的附加上下文（均为短字符串/数字）
  if (typeof meta.reason === 'string' && meta.reason) entry.reason = truncateField(meta.reason)
  if (typeof meta.exitCode === 'number' && Number.isFinite(meta.exitCode))
    entry.exitCode = meta.exitCode
  if (typeof meta.dump === 'string' && meta.dump) entry.dump = truncateField(meta.dump)
  return entry
}

/**
 * 校验并归一化渲染层经 IPC 上报的错误载荷。
 * 来源固定为 renderer、级别固定为 error（客户端不可指定）；
 * 只接受白名单字段，非字符串/越界字段一律丢弃。
 * @param {unknown} raw
 * @returns {{ message: string, stack?: string, filename?: string, lineno?: number, colno?: number } | null}
 */
function normalizeRendererReport(raw) {
  if (!raw || typeof raw !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (raw)
  if (typeof r.message !== 'string' || !r.message) return null
  /** @type {{ message: string, stack?: string, filename?: string, lineno?: number, colno?: number }} */
  const out = { message: truncateField(r.message) }
  if (typeof r.stack === 'string' && r.stack) out.stack = truncateField(r.stack)
  if (typeof r.filename === 'string' && r.filename) out.filename = truncateField(r.filename)
  if (typeof r.lineno === 'number' && Number.isFinite(r.lineno)) out.lineno = r.lineno
  if (typeof r.colno === 'number' && Number.isFinite(r.colno)) out.colno = r.colno
  return out
}

/**
 * 从未见过的 minidump 文件名清单（对照 .seen-dumps）。
 * 纯函数：只做集合差集，文件 IO 由 scanNewDumps 负责。
 * @param {string[]} files - 崩溃目录中现有的全部文件名
 * @param {string[]} seen - 已登记过的文件名
 * @returns {string[]}
 */
function listNewDumps(files, seen) {
  const known = new Set(Array.isArray(seen) ? seen : [])
  return files.filter(
    (name) => typeof name === 'string' && name.endsWith('.dmp') && !known.has(name),
  )
}

/**
 * 递归收集崩溃目录下全部 minidump 的相对路径。
 * crashReporter 重定位目录后，crashpad 以数据库形式管理转储，.dmp 实际落在
 * pending/（uploadToServer:false 时常驻于此）、new/、completed/ 等子目录而非顶层，
 * 只 readdir 顶层会漏掉全部转储。
 * @param {typeof fs} fsImpl
 * @param {string} dir - 当前遍历的绝对目录
 * @param {string} [prefix] - 相对崩溃根目录的前缀
 * @returns {Promise<string[]>} 形如 'pending/xxxx.dmp'（顶层文件即 basename）
 */
async function collectDumpFiles(fsImpl, dir, prefix = '') {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fsImpl.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  /** @type {string[]} */
  const out = []
  for (const ent of entries) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      out.push(...(await collectDumpFiles(fsImpl, path.join(dir, ent.name), rel)))
    } else if (ent.isFile() && ent.name.endsWith('.dmp')) {
      out.push(rel)
    }
  }
  return out
}

/**
 * 创建日志写入器。
 *
 * 串行化：所有写盘经同一条 Promise 链排队，避免并发 append 行交错；
 * 去重：同 source+message 在 DEDUP_WINDOW_MS 内重复仅计数，窗口过后由下一条
 * 任意日志「顺带」冲刷出一行 `相同消息重复 N 次` 的汇总（无后台定时器，保持轻量）。
 *
 * @param {{ home: string, now?: () => Date, fsImpl?: typeof fs }} options
 */
function createLogger({ home, now = () => new Date(), fsImpl = fs }) {
  /** @type {Map<string, { count: number, at: number, source: string, message: string }>} */
  const recent = new Map()
  let chain = Promise.resolve()

  /**
   * 冲刷所有已过窗口且发生过重复的去重记录（汇总成行），并清空过期记录。
   * @param {number} atMs
   */
  function flushExpired(atMs) {
    for (const [key, rec] of recent) {
      if (atMs - rec.at < DEDUP_WINDOW_MS) continue
      recent.delete(key)
      if (rec.count >= 2) {
        enqueueRaw(
          buildEntry(
            'warn',
            rec.source,
            `相同消息在 ${DEDUP_WINDOW_MS / 1000} 秒内重复 ${rec.count} 次: ${rec.message}`,
            undefined,
            {},
            now(),
          ),
        )
      }
    }
  }

  /**
   * 把已组装的记录实际追加到当天日文件（调用前已完成去重判定）。
   * @param {Record<string, unknown> | null} entry
   */
  function enqueueRaw(entry) {
    if (!entry) return
    chain = chain
      .then(async () => {
        const dir = logsDir(home)
        await fsImpl.mkdir(dir, { recursive: true })
        // 每次写盘顺带轮转：错误日志频率很低，readdir 成本可忽略
        const names = await fsImpl.readdir(dir).catch(() => [])
        const entries = []
        for (const name of names) {
          if (!name.startsWith('app-') || !name.endsWith('.jsonl')) continue
          const st = await fsImpl.stat(path.join(dir, name)).catch(() => null)
          if (st) entries.push({ name, mtime: st.mtime })
        }
        for (const stale of pruneLogFiles(entries, now())) {
          await fsImpl.unlink(path.join(dir, stale)).catch(() => {})
        }
        await fsImpl.appendFile(
          path.join(dir, logFileName(localDate(now()))),
          `${JSON.stringify(entry)}\n`,
          'utf-8',
        )
      })
      .catch(() => {
        /* 日志写盘失败：静默，禁止递归进入异常钩子 */
      })
  }

  /**
   * 记录一条日志。
   * @param {string} level
   * @param {string} source
   * @param {unknown} message
   * @param {string} [stack]
   * @param {{ filename?: string, lineno?: number, colno?: number, reason?: string, exitCode?: number, dump?: string }} [meta]
   */
  function log(level, source, message, stack, meta) {
    const atMs = now().getTime()
    flushExpired(atMs)
    const entry = buildEntry(level, source, message, stack, meta, now())
    if (!entry) return
    const key = `${source}\u0000${typeof message === 'string' ? message : String(message ?? '')}`
    const hit = recent.get(key)
    if (hit) {
      // 窗口内重复：仅计数不写盘（flushExpired 已保证 hit 未过窗口）
      hit.count += 1
      hit.at = atMs
      return
    }
    recent.set(key, { count: 1, at: atMs, source, message: String(entry.message) })
    enqueueRaw(entry)
  }

  /**
   * 记录子进程（渲染器 / GPU / utility）消失事件。
   * @param {{ type?: string, reason?: string, exitCode?: number, name?: string }} details
   */
  function logChildProcessGone(details) {
    const d = details ?? {}
    log(
      'error',
      'child-process',
      `${typeof d.type === 'string' ? d.type : 'unknown'} 进程异常退出: ${
        typeof d.reason === 'string' ? d.reason : 'unknown'
      }`,
      undefined,
      { reason: d.reason, exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined },
    )
  }

  /**
   * 登记一枚本次启动新发现的原生崩溃 minidump。
   * @param {string} dumpFile
   * @param {{ size?: number } | null} [stat]
   */
  function logNativeCrash(dumpFile, stat) {
    log(
      'warn',
      'native-crash',
      `检测到上次运行留下的崩溃转储: ${dumpFile}（${stat?.size ?? 0} 字节）`,
      undefined,
      { dump: dumpFile },
    )
  }

  /**
   * 等待当前排队中的写盘完成（测试与关机场景用）。
   * @returns {Promise<void>}
   */
  function flush() {
    return chain
  }

  return { log, logChildProcessGone, logNativeCrash, flush }
}

/**
 * 启动扫描：把崩溃目录中未登记过的 minidump 写入日志并更新 .seen-dumps 清单。
 *
 * 主进程自身原生崩溃时来不及写日志行，只能靠下次启动在此补记线索；
 * 崩溃目录缺失（从未崩溃过）属正常情况，静默返回。
 *
 * @param {ReturnType<typeof createLogger>} logger
 * @param {string} home
 * @param {{ fsImpl?: typeof fs }} [options]
 * @returns {Promise<void>}
 */
async function scanNewDumps(logger, home, { fsImpl = fs } = {}) {
  const dumpDir = crashDumpsDir(home)
  const dir = logsDir(home)
  const seenFile = path.join(dir, '.seen-dumps')

  /** @type {string[]} */
  let seen = []
  try {
    const parsed = JSON.parse(await fsImpl.readFile(seenFile, 'utf-8'))
    if (Array.isArray(parsed)) seen = parsed.filter((x) => typeof x === 'string')
  } catch {
    /* 清单缺失或损坏：视为空清单（首次启动 / 文件被手改） */
  }

  // 崩溃目录尚不存在：从未发生过原生崩溃，静默返回
  const dirExists = await fsImpl.access(dumpDir).then(
    () => true,
    () => false,
  )
  if (!dirExists) return
  // 递归收集：crashpad 把 .dmp 放在 pending/ 等子目录（见 collectDumpFiles 说明）
  /** @type {string[]} */
  const files = await collectDumpFiles(fsImpl, dumpDir)

  for (const name of listNewDumps(files, seen)) {
    const st = await fsImpl.stat(path.join(dumpDir, name)).catch(() => null)
    logger.logNativeCrash(name, st ? { size: st.size } : null)
  }

  // 清单以崩溃目录现状为准（用户手动删掉 dump 后清单同步收敛）
  await fsImpl.mkdir(dir, { recursive: true }).catch(() => {})
  await fsImpl.writeFile(seenFile, JSON.stringify(files, null, 2), 'utf-8').catch(() => {})
  await logger.flush()
}

module.exports = {
  tmdHome,
  logsDir,
  crashDumpsDir,
  localDate,
  logFileName,
  pruneLogFiles,
  truncateField,
  buildEntry,
  normalizeRendererReport,
  listNewDumps,
  collectDumpFiles,
  createLogger,
  scanNewDumps,
  LOG_RETENTION_DAYS,
  LOG_RETENTION_FILES,
  FIELD_MAX,
  DEDUP_WINDOW_MS,
}
