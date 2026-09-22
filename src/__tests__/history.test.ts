import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// electron/history.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载验证路径解析/去重/剪枝/列举/读取逻辑
// （与主进程同一代码路径，同 logger.test.ts 范式）。
const require = createRequire(import.meta.url)
const historyMod = require('../../electron/history.cjs') as {
  HISTORY_MAX_PER_FILE: number
  HISTORY_MAX_TOTAL_BYTES: number
  historyDir: (home: string) => string
  snapshotKey: (filePath: string) => string
  snapshotDir: (root: string, filePath: string) => string
  stampId: (date: Date) => string
  isValidId: (id: unknown) => boolean
  contentHash: (content: string) => string
  uniqueId: (used: Set<string>, now: Date) => string
  writeSnapshot: (
    root: string,
    entry: { path: string; name: string; content: string; now?: Date },
    options?: { fsImpl?: typeof import('node:fs/promises') },
  ) => Promise<{ saved: boolean; id?: string; reason?: string }>
  listSnapshots: (
    root: string,
    filePath: string,
    options?: { fsImpl?: typeof import('node:fs/promises') },
  ) => Promise<{
    path: string
    name: string
    snapshots: { id: string; ts: string; size: number }[]
  } | null>
  readSnapshot: (
    root: string,
    filePath: string,
    id: string,
    options?: { fsImpl?: typeof import('node:fs/promises') },
  ) => Promise<{ id: string; ts: string; content: string } | null>
  pruneHistory: (
    root: string,
    options?: { fsImpl?: typeof import('node:fs/promises') },
  ) => Promise<{ removed: number; bytes: number }>
}

/** 每个用例独立的临时根目录（history 根 + 假源文件路径） */
let root = ''
const FILE = '/docs/sample.md'

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tmd-history-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 读取某源文件的 index.json */
async function readIndexJson(filePath = FILE) {
  const raw = await readFile(
    path.join(historyMod.snapshotDir(root, filePath), 'index.json'),
    'utf-8',
  )
  return JSON.parse(raw)
}

describe('history 路径与命名', () => {
  it('根目录落在 ~/.tmd/history（与 themes / logs 同级）', () => {
    expect(historyMod.historyDir('/Users/tester')).toBe(
      path.join('/Users/tester', '.tmd', 'history'),
    )
  })

  it('同一路径稳定映射同一 key，不同路径映射不同 key', () => {
    expect(historyMod.snapshotKey(FILE)).toBe(historyMod.snapshotKey(FILE))
    expect(historyMod.snapshotKey(FILE)).not.toBe(historyMod.snapshotKey('/docs/other.md'))
    expect(historyMod.snapshotKey(FILE)).toHaveLength(16)
  })

  it('含 .. 的路径先 resolve 归一（同一文件不因书写差异分裂历史）', () => {
    expect(historyMod.snapshotKey('/docs/../docs/sample.md')).toBe(historyMod.snapshotKey(FILE))
  })

  it('非 Linux 平台路径大小写归一', () => {
    if (process.platform === 'linux') {
      // Linux 大小写敏感：A.md 与 a.md 是两个文件，不能合并
      expect(historyMod.snapshotKey('/docs/A.md')).not.toBe(historyMod.snapshotKey('/docs/a.md'))
      return
    }
    expect(historyMod.snapshotKey('/docs/A.md')).toBe(historyMod.snapshotKey('/docs/a.md'))
  })

  it('快照目录挂在根目录下且与源文件同名无关（只用 key）', () => {
    const dir = historyMod.snapshotDir(root, FILE)
    expect(path.dirname(dir)).toBe(root)
    expect(path.basename(dir)).toBe(historyMod.snapshotKey(FILE))
  })

  it('stampId 输出 YYYYMMDD-HHmmss 本地时间串', () => {
    expect(historyMod.stampId(new Date(2026, 8, 17, 15, 30, 12))).toBe('20260917-153012')
    expect(historyMod.stampId(new Date(2026, 0, 5, 9, 8, 7))).toBe('20260105-090807')
  })

  it('isValidId 拒绝目录穿越与畸形 id', () => {
    expect(historyMod.isValidId('20260917-153012')).toBe(true)
    expect(historyMod.isValidId('20260917-153012-2')).toBe(true)
    expect(historyMod.isValidId('../index')).toBe(false)
    expect(historyMod.isValidId('20260917-153012.md')).toBe(false)
    expect(historyMod.isValidId('')).toBe(false)
    expect(historyMod.isValidId(null)).toBe(false)
  })

  it('uniqueId 在秒级冲突时追加序号', () => {
    const now = new Date(2026, 8, 17, 15, 30, 12)
    expect(historyMod.uniqueId(new Set(), now)).toBe('20260917-153012')
    expect(historyMod.uniqueId(new Set(['20260917-153012']), now)).toBe('20260917-153012-2')
    expect(historyMod.uniqueId(new Set(['20260917-153012', '20260917-153012-2']), now)).toBe(
      '20260917-153012-3',
    )
  })

  it('contentHash 同内容同指纹、异内容异指纹', () => {
    expect(historyMod.contentHash('abc')).toBe(historyMod.contentHash('abc'))
    expect(historyMod.contentHash('abc')).not.toBe(historyMod.contentHash('abd'))
  })
})

describe('writeSnapshot 写入与去重', () => {
  it('首条快照落盘并生成 index（正文 + 元信息）', async () => {
    const now = new Date(2026, 8, 17, 10, 0, 0)
    const result = await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: '# 旧标题\n',
      now,
    })

    expect(result.saved).toBe(true)
    expect(result.id).toBe('20260917-100000')

    const dir = historyMod.snapshotDir(root, FILE)
    expect(await readFile(path.join(dir, '20260917-100000.md'), 'utf-8')).toBe('# 旧标题\n')
    const index = await readIndexJson()
    expect(index.path).toBe(FILE)
    expect(index.name).toBe('sample.md')
    expect(index.snapshots).toHaveLength(1)
    expect(index.snapshots[0]).toMatchObject({
      id: '20260917-100000',
      ts: now.toISOString(),
      size: Buffer.byteLength('# 旧标题\n', 'utf-8'),
    })
  })

  it('与最新一条内容相同则跳过（自动保存每 5 秒写盘，靠指纹挡重复）', async () => {
    await historyMod.writeSnapshot(root, { path: FILE, name: 'sample.md', content: 'same' })
    const second = await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'same',
    })
    expect(second).toEqual({ saved: false, reason: 'duplicate' })
    const index = await readIndexJson()
    expect(index.snapshots).toHaveLength(1)
  })

  it('内容变化后允许新增，且最新在前', async () => {
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'v1',
      now: new Date(2026, 8, 17, 10, 0, 0),
    })
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'v2',
      now: new Date(2026, 8, 17, 10, 5, 0),
    })
    const index = await readIndexJson()
    expect(index.snapshots.map((s: { id: string }) => s.id)).toEqual([
      '20260917-100500',
      '20260917-100000',
    ])
  })

  it('内容改回旧版本仍新增（与最新一条不同即可）', async () => {
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'A' })
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'B' })
    const back = await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'A' })
    expect(back.saved).toBe(true)
    expect((await readIndexJson()).snapshots).toHaveLength(3)
  })

  it('空内容 / 无路径不产生快照', async () => {
    expect(await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: '' })).toEqual(
      {
        saved: false,
        reason: 'empty',
      },
    )
    expect(await historyMod.writeSnapshot(root, { path: '', name: 's.md', content: 'x' })).toEqual({
      saved: false,
      reason: 'no-path',
    })
    expect(await readdir(root)).toHaveLength(0)
  })

  it('同一秒内连续写多条时 id 不冲突', async () => {
    const now = new Date(2026, 8, 17, 10, 0, 0)
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'v1', now })
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'v2', now })
    const index = await readIndexJson()
    expect(index.snapshots.map((s: { id: string }) => s.id)).toEqual([
      '20260917-100000-2',
      '20260917-100000',
    ])
  })

  it('换路径保存时在新 key 下独立建历史（旧历史留在原 key）', async () => {
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'v1',
    })
    const renamed = '/docs/renamed.md'
    await historyMod.writeSnapshot(root, { path: renamed, name: 'renamed.md', content: 'v2' })
    const index = await readIndexJson(renamed)
    expect(index.path).toBe(renamed)
    expect(index.name).toBe('renamed.md')
    // 原路径的历史不受影响
    expect((await historyMod.listSnapshots(root, FILE))?.snapshots).toHaveLength(1)
  })

  it('index 中的 name 随每次写入刷新', async () => {
    await historyMod.writeSnapshot(root, { path: FILE, name: 'old.md', content: 'v1' })
    await historyMod.writeSnapshot(root, { path: FILE, name: 'new.md', content: 'v2' })
    expect((await readIndexJson()).name).toBe('new.md')
  })

  it('超过单文件数量上限时删最旧、保留最新', async () => {
    const total = historyMod.HISTORY_MAX_PER_FILE + 5
    for (let i = 0; i < total; i++) {
      // 每条内容不同，避免被去重挡掉
      await historyMod.writeSnapshot(root, {
        path: FILE,
        name: 's.md',
        content: `v${i}`,
        now: new Date(2026, 8, 17, 10, 0, i),
      })
    }
    const index = await readIndexJson()
    expect(index.snapshots).toHaveLength(historyMod.HISTORY_MAX_PER_FILE)
    // 最新一条是 v{total-1}，最旧的那 5 条（v0..v4）应已删除
    expect(index.snapshots[0].id).toBe(historyMod.stampId(new Date(2026, 8, 17, 10, 0, total - 1)))
    const files = (await readdir(historyMod.snapshotDir(root, FILE))).filter((f) =>
      f.endsWith('.md'),
    )
    expect(files).toHaveLength(historyMod.HISTORY_MAX_PER_FILE)
  })

  it('index.json 损坏时视为无历史（不抛异常，可继续写入）', async () => {
    const dir = historyMod.snapshotDir(root, FILE)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.json'), '{ 坏掉的 JSON', 'utf-8')
    const result = await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'v1' })
    expect(result.saved).toBe(true)
    expect((await readIndexJson()).snapshots).toHaveLength(1)
    // 损坏内容需留档，否则旧快照元信息会被空列表静默覆盖
    const files = await readdir(dir)
    expect(files.some((f) => f.includes('.corrupt-'))).toBe(true)
  })
})

describe('listSnapshots / readSnapshot', () => {
  it('无历史时返回 null', async () => {
    expect(await historyMod.listSnapshots(root, FILE)).toBeNull()
  })

  it('列出快照为最新在前且不外传内部 hash 字段', async () => {
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'v1',
      now: new Date(2026, 8, 17, 10, 0, 0),
    })
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 'sample.md',
      content: 'v2',
      now: new Date(2026, 8, 17, 10, 5, 0),
    })
    const listed = await historyMod.listSnapshots(root, FILE)
    expect(listed?.path).toBe(FILE)
    expect(listed?.name).toBe('sample.md')
    expect(listed?.snapshots.map((s) => s.id)).toEqual(['20260917-100500', '20260917-100000'])
    expect(Object.keys(listed?.snapshots[0] ?? {}).sort()).toEqual(['id', 'size', 'ts'])
  })

  it('读取快照正文与对应时间戳', async () => {
    await historyMod.writeSnapshot(root, {
      path: FILE,
      name: 's.md',
      content: '被覆盖的旧内容',
      now: new Date(2026, 8, 17, 10, 0, 0),
    })
    const snap = await historyMod.readSnapshot(root, FILE, '20260917-100000')
    expect(snap?.content).toBe('被覆盖的旧内容')
    expect(snap?.ts).toBe(new Date(2026, 8, 17, 10, 0, 0).toISOString())
  })

  it('读取非法 id 或不存在 id 一律返回 null（防目录穿越）', async () => {
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'v1' })
    expect(await historyMod.readSnapshot(root, FILE, '../index')).toBeNull()
    expect(await historyMod.readSnapshot(root, FILE, '20200101-000000')).toBeNull()
  })
})

describe('pruneHistory 容量兜底', () => {
  it('历史目录不存在时静默返回', async () => {
    expect(await historyMod.pruneHistory(path.join(root, 'missing'))).toEqual({
      removed: 0,
      bytes: 0,
    })
  })

  it('总量未超上限时不删除', async () => {
    await historyMod.writeSnapshot(root, { path: FILE, name: 's.md', content: 'v1' })
    const result = await historyMod.pruneHistory(root)
    expect(result.removed).toBe(0)
    expect(result.bytes).toBe(Buffer.byteLength('v1', 'utf-8'))
  })

  // 直接在 index.json 里写超大 size（prune 只读 index 记账，不 stat 文件），
  // 免得真造 200MB 数据
  it('总量超上限时跨文件按时间最旧优先删除', async () => {
    const half = Math.floor(historyMod.HISTORY_MAX_TOTAL_BYTES / 2) + 1024
    const targets = [
      { path: '/docs/old.md', id: '20260101-100000', ts: '2026-01-01T02:00:00.000Z' },
      { path: '/docs/new.md', id: '20260601-100000', ts: '2026-06-01T02:00:00.000Z' },
    ]
    for (const t of targets) {
      const dir = historyMod.snapshotDir(root, t.path)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${t.id}.md`), 'x', 'utf-8')
      await writeFile(
        path.join(dir, 'index.json'),
        JSON.stringify({
          path: t.path,
          name: path.basename(t.path),
          snapshots: [{ id: t.id, ts: t.ts, size: half, hash: 'h' }],
        }),
        'utf-8',
      )
    }

    const result = await historyMod.pruneHistory(root)
    // 两份各半超出上限 → 删掉最旧的一份后回落（保留最新那份）
    expect(result.removed).toBeGreaterThan(0)
    expect(result.bytes).toBeLessThanOrEqual(historyMod.HISTORY_MAX_TOTAL_BYTES)
    expect(await historyMod.listSnapshots(root, '/docs/old.md')).toBeNull()
    expect(await historyMod.listSnapshots(root, '/docs/new.md')).not.toBeNull()
  })
})
