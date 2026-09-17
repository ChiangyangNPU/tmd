import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// electron/logger.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载验证目录解析/轮转/截断/去重/崩溃清单逻辑
// （与主进程同一代码路径，同 themes.test.ts 范式）。
const require = createRequire(import.meta.url)
const loggerMod = require('../../electron/logger.cjs') as {
  tmdHome: (env?: NodeJS.ProcessEnv, home?: string) => string
  logsDir: (home: string) => string
  crashDumpsDir: (home: string) => string
  localDate: (date?: Date) => string
  logFileName: (date: string) => string
  pruneLogFiles: (entries: { name: string; mtime: number | Date }[], now?: Date) => string[]
  truncateField: (value: unknown) => string
  buildEntry: (
    level: string,
    source: string,
    message: unknown,
    stack?: string,
    meta?: Record<string, unknown>,
    now?: Date,
  ) => Record<string, unknown> | null
  normalizeRendererReport: (raw: unknown) => Record<string, unknown> | null
  listNewDumps: (files: string[], seen: string[]) => string[]
  collectDumpFiles: (
    fsImpl: typeof import('node:fs/promises'),
    dir: string,
    prefix?: string,
  ) => Promise<string[]>
  createLogger: (opts: {
    home: string
    now?: () => Date
    fsImpl?: typeof import('node:fs/promises')
  }) => {
    log: (
      level: string,
      source: string,
      message: unknown,
      stack?: string,
      meta?: Record<string, unknown>,
    ) => void
    logChildProcessGone: (details: Record<string, unknown>) => void
    logNativeCrash: (dumpFile: string, stat?: { size?: number } | null) => void
    flush: () => Promise<void>
  }
  scanNewDumps: (
    logger: ReturnType<typeof loggerMod.createLogger>,
    home: string,
    opts?: { fsImpl?: typeof import('node:fs/promises') },
  ) => Promise<void>
  LOG_RETENTION_FILES: number
  FIELD_MAX: number
  DEDUP_WINDOW_MS: number
}

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tmd-logger-'))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** 读取当天日志文件的全部行（按注入时钟的日期推导文件名） */
async function readLogLines(home: string, clock: () => Date): Promise<string[]> {
  const file = path.join(
    loggerMod.logsDir(home),
    loggerMod.logFileName(loggerMod.localDate(clock())),
  )
  const text = await readFile(file, 'utf-8')
  return text.split('\n').filter(Boolean)
}

describe('tmdHome / 目录解析', () => {
  it('TMD_HOME_DIR 非空时重定位根目录，否则回落到用户主目录', () => {
    expect(loggerMod.tmdHome({ TMD_HOME_DIR: '/tmp/x' }, '/home/u')).toBe('/tmp/x')
    expect(loggerMod.tmdHome({ TMD_HOME_DIR: '' }, '/home/u')).toBe('/home/u')
    expect(loggerMod.tmdHome({}, '/home/u')).toBe('/home/u')
  })

  it('日志与崩溃目录位于 ~/.tmd 下且互相独立', () => {
    expect(loggerMod.logsDir('/home/u')).toBe(path.join('/home/u', '.tmd', 'logs'))
    expect(loggerMod.crashDumpsDir('/home/u')).toBe(path.join('/home/u', '.tmd', 'crash-dumps'))
  })
})

describe('localDate / logFileName', () => {
  it('产出本地日期串与按天文件名', () => {
    const d = new Date(2026, 8, 17, 10, 0, 0)
    expect(loggerMod.localDate(d)).toBe('2026-09-17')
    expect(loggerMod.logFileName('2026-09-17')).toBe('app-2026-09-17.jsonl')
  })
})

describe('pruneLogFiles', () => {
  const now = new Date(2026, 8, 17, 12, 0, 0)

  it('不超龄且不超数量时全部保留', () => {
    const entries = [
      { name: 'a.jsonl', mtime: new Date(2026, 8, 16).getTime() },
      { name: 'b.jsonl', mtime: new Date(2026, 8, 17).getTime() },
    ]
    expect(loggerMod.pruneLogFiles(entries, now)).toEqual([])
  })

  it('删除超龄文件（早于 7 天）', () => {
    const entries = [
      { name: 'old.jsonl', mtime: new Date(2026, 8, 9).getTime() },
      { name: 'fresh.jsonl', mtime: new Date(2026, 8, 15).getTime() },
    ]
    expect(loggerMod.pruneLogFiles(entries, now)).toEqual(['old.jsonl'])
  })

  it('同日内超过数量上限时从最旧开始删', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.jsonl`,
      mtime: new Date(2026, 8, 17, i).getTime(),
    }))
    const removed = loggerMod.pruneLogFiles(entries, now)
    expect(removed).toEqual(['f0.jsonl', 'f1.jsonl'])
  })
})

describe('truncateField', () => {
  it('非字符串安全字符串化', () => {
    expect(loggerMod.truncateField(42)).toBe('42')
    expect(loggerMod.truncateField(undefined)).toBe('')
    expect(loggerMod.truncateField(null)).toBe('')
  })

  it('超长截断并附标记', () => {
    const long = 'x'.repeat(loggerMod.FIELD_MAX + 100)
    const out = loggerMod.truncateField(long)
    expect(out.length).toBeLessThanOrEqual(loggerMod.FIELD_MAX + 20)
    expect(out.endsWith('[truncated]')).toBe(true)
  })
})

describe('buildEntry', () => {
  it('合法入参产出白名单结构', () => {
    const e = loggerMod.buildEntry(
      'error',
      'renderer',
      'boom',
      'Error: boom\n  at x',
      { filename: 'a.ts', lineno: 3, colno: 12 },
      new Date(Date.UTC(2026, 8, 17, 0, 0, 0)),
    )
    expect(e).toEqual({
      ts: '2026-09-17T00:00:00.000Z',
      level: 'error',
      source: 'renderer',
      message: 'boom',
      stack: 'Error: boom\n  at x',
      filename: 'a.ts',
      lineno: 3,
      colno: 12,
    })
  })

  it('非法级别/来源/空消息返回 null', () => {
    expect(loggerMod.buildEntry('info', 'main', 'x')).toBeNull()
    expect(loggerMod.buildEntry('error', 'network', 'x')).toBeNull()
    expect(loggerMod.buildEntry('error', 'main', '')).toBeNull()
    expect(loggerMod.buildEntry('error', 'main', undefined)).toBeNull()
  })

  it('丢弃非白名单 meta 字段与非法类型', () => {
    const e = loggerMod.buildEntry('warn', 'main', 'm', undefined, {
      reason: 'crashed',
      exitCode: 11,
      secret: 'doc content',
      lineno: 'no',
    }) as Record<string, unknown>
    expect(e.reason).toBe('crashed')
    expect(e.exitCode).toBe(11)
    expect('secret' in e).toBe(false)
    expect('lineno' in e).toBe(false)
  })
})

describe('normalizeRendererReport', () => {
  it('接受合法载荷并丢弃非法类型字段', () => {
    const out = loggerMod.normalizeRendererReport({
      message: 'oops',
      stack: 'st',
      filename: 'f.ts',
      lineno: 1,
      colno: 2,
      level: 'admin', // 不接受客户端指定级别
    }) as Record<string, unknown>
    expect(out).toEqual({ message: 'oops', stack: 'st', filename: 'f.ts', lineno: 1, colno: 2 })
  })

  it('非对象或缺 message 返回 null', () => {
    expect(loggerMod.normalizeRendererReport(null)).toBeNull()
    expect(loggerMod.normalizeRendererReport('x')).toBeNull()
    expect(loggerMod.normalizeRendererReport({})).toBeNull()
    expect(loggerMod.normalizeRendererReport({ message: '' })).toBeNull()
  })

  it('message 超长截断', () => {
    const out = loggerMod.normalizeRendererReport({ message: 'y'.repeat(9999) }) as {
      message: string
    }
    expect(out.message.endsWith('[truncated]')).toBe(true)
  })
})

describe('listNewDumps', () => {
  it('只返回未见且以 .dmp 结尾的文件名', () => {
    const files = ['a.dmp', 'b.dmp', 'notes.txt', '.hidden']
    expect(loggerMod.listNewDumps(files, ['a.dmp'])).toEqual(['b.dmp'])
    expect(loggerMod.listNewDumps(files, [])).toEqual(['a.dmp', 'b.dmp'])
    expect(loggerMod.listNewDumps(files, ['a.dmp', 'b.dmp'])).toEqual([])
  })
})

describe('createLogger 写盘集成', () => {
  it('写入一条 JSONL：字段齐全、可被 JSON.parse、目录自动创建', async () => {
    const clock = () => new Date(2026, 8, 17, 10, 0, 0)
    const logger = loggerMod.createLogger({ home: tempRoot, now: clock })
    logger.log('error', 'main', '主进程炸了', 'Error: x')
    await logger.flush()

    const lines = await readLogLines(tempRoot, clock)
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0])
    expect(row.level).toBe('error')
    expect(row.source).toBe('main')
    expect(row.message).toBe('主进程炸了')
    expect(row.stack).toBe('Error: x')
    expect(typeof row.ts).toBe('string')
  })

  it('窗口内重复仅落一行；窗口过后冲刷汇总行再写新行', async () => {
    let t = new Date(2026, 8, 17, 10, 0, 0).getTime()
    const clock = () => new Date(t)
    const logger = loggerMod.createLogger({ home: tempRoot, now: clock })

    logger.log('error', 'renderer', '重复错误')
    logger.log('error', 'renderer', '重复错误')
    logger.log('error', 'renderer', '重复错误')
    await logger.flush()
    expect(await readLogLines(tempRoot, clock)).toHaveLength(1)

    // 推进超过去重窗口，再发一次同样的错误：
    // 先冲刷「重复 3 次」汇总行，再写当前完整行
    t += loggerMod.DEDUP_WINDOW_MS + 1000
    logger.log('error', 'renderer', '重复错误')
    await logger.flush()

    const lines = await readLogLines(tempRoot, clock)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[1]).message).toContain('重复 3 次')
    expect(JSON.parse(lines[2]).message).toBe('重复错误')
  })

  it('不同消息各自成行，子进程崩溃带 reason/exitCode', async () => {
    const clock = () => new Date(2026, 8, 17, 10, 0, 0)
    const logger = loggerMod.createLogger({ home: tempRoot, now: clock })
    logger.log('warn', 'main', 'a')
    logger.log('warn', 'main', 'b')
    logger.logChildProcessGone({ type: 'renderer', reason: 'crashed', exitCode: 139 })
    await logger.flush()

    const rows = (await readLogLines(tempRoot, clock)).map((l) => JSON.parse(l))
    expect(rows.map((r) => r.message)).toEqual(['a', 'b', 'renderer 进程异常退出: crashed'])
    expect(rows[2].source).toBe('child-process')
    expect(rows[2].reason).toBe('crashed')
    expect(rows[2].exitCode).toBe(139)
  })

  it('写盘时顺带轮转：删除超龄与超量的旧日文件', async () => {
    const dir = loggerMod.logsDir(tempRoot)
    await mkdir(dir, { recursive: true })
    const now = new Date(2026, 8, 17, 10, 0, 0)
    // 一个超龄文件 + 11 个近两天文件（共应删 2 个：超龄 1 + 超量 1）
    await writeFile(path.join(dir, 'app-2020-01-01.jsonl'), 'old\n')
    await utimes(path.join(dir, 'app-2020-01-01.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    for (let i = 0; i < 11; i++) {
      const name = `app-2026-09-1${i < 6 ? '5' : '6'}-${String(i).padStart(2, '0')}.jsonl`
      const full = path.join(dir, name)
      await writeFile(full, `x${i}\n`)
      const mtime = new Date(2026, 8, i < 6 ? 15 : 16, i)
      await utimes(full, mtime, mtime)
    }

    const logger = loggerMod.createLogger({ home: tempRoot, now: () => now })
    logger.log('error', 'main', '触发轮转')
    await logger.flush()

    const left = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort()
    expect(left).not.toContain('app-2020-01-01.jsonl')
    // 11 个近期文件删最旧 1 个 + 新增当天文件 = 11
    expect(left).toHaveLength(11)
  })
})

describe('scanNewDumps', () => {
  it('首次发现的 dump 写入日志并生成 .seen-dumps 清单', async () => {
    const clock = () => new Date(2026, 8, 17, 10, 0, 0)
    const dumpDir = loggerMod.crashDumpsDir(tempRoot)
    await mkdir(dumpDir, { recursive: true })
    await writeFile(path.join(dumpDir, 'a1b2.dmp'), Buffer.from([1, 2, 3, 4]))
    await writeFile(path.join(dumpDir, 'c3d4.dmp'), Buffer.alloc(8))

    const logger = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger, tempRoot)

    const rows = (await readLogLines(tempRoot, clock)).map((l) => JSON.parse(l))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'native-crash')).toBe(true)
    expect(rows.map((r) => r.dump).sort()).toEqual(['a1b2.dmp', 'c3d4.dmp'])

    const seen = JSON.parse(
      await readFile(path.join(loggerMod.logsDir(tempRoot), '.seen-dumps'), 'utf-8'),
    )
    expect(seen.sort()).toEqual(['a1b2.dmp', 'c3d4.dmp'])
  })

  it('二次扫描不重复登记；清单损坏按空清单重建', async () => {
    const clock = () => new Date(2026, 8, 17, 10, 0, 0)
    const dumpDir = loggerMod.crashDumpsDir(tempRoot)
    await mkdir(dumpDir, { recursive: true })
    await writeFile(path.join(dumpDir, 'x.dmp'), Buffer.from([1]))

    const logger1 = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger1, tempRoot)

    const logger2 = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger2, tempRoot)
    expect(await readLogLines(tempRoot, clock)).toHaveLength(1)

    // 清单损坏 + 新增一个 dump：两个都会重新登记
    await writeFile(path.join(loggerMod.logsDir(tempRoot), '.seen-dumps'), 'not-json{')
    await writeFile(path.join(dumpDir, 'y.dmp'), Buffer.from([2]))
    const logger3 = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger3, tempRoot)
    expect(await readLogLines(tempRoot, clock)).toHaveLength(3)
  })

  it('崩溃目录缺失（从未崩溃）时静默返回、不报错', async () => {
    const logger = loggerMod.createLogger({ home: tempRoot })
    await expect(loggerMod.scanNewDumps(logger, tempRoot)).resolves.toBeUndefined()
  })

  it('递归发现 crashpad 子目录（pending/new）中的 dump，清单与日志用相对路径', async () => {
    const clock = () => new Date(2026, 8, 17, 10, 0, 0)
    const dumpDir = loggerMod.crashDumpsDir(tempRoot)
    // 真实布局：crashpad 数据库子目录 + settings.dat，顶层无 .dmp
    await mkdir(path.join(dumpDir, 'pending'), { recursive: true })
    await mkdir(path.join(dumpDir, 'new'), { recursive: true })
    await writeFile(path.join(dumpDir, 'settings.dat'), Buffer.from([0]))
    await writeFile(path.join(dumpDir, 'pending', 'p1.dmp'), Buffer.from([1, 2]))
    await writeFile(path.join(dumpDir, 'new', 'n1.dmp'), Buffer.from([3, 4]))
    await writeFile(path.join(dumpDir, 'pending', 'notes.txt'), Buffer.from([5]))

    const logger = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger, tempRoot)

    const rows = (await readLogLines(tempRoot, clock)).map((l) => JSON.parse(l))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.dump).sort()).toEqual(['new/n1.dmp', 'pending/p1.dmp'])

    const seen = JSON.parse(
      await readFile(path.join(loggerMod.logsDir(tempRoot), '.seen-dumps'), 'utf-8'),
    )
    expect(seen.sort()).toEqual(['new/n1.dmp', 'pending/p1.dmp'])

    // 二次扫描不重复登记
    const logger2 = loggerMod.createLogger({ home: tempRoot, now: clock })
    await loggerMod.scanNewDumps(logger2, tempRoot)
    expect(await readLogLines(tempRoot, clock)).toHaveLength(2)
  })
})
