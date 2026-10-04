import { describe, it, expect, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, rename, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// electron/filewatcher.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载，用真实临时目录 + 真实 fs.watch 验证
// 指纹过滤 / 自身写入抑制 / unlink 通知（与主进程同一代码路径）
const require = createRequire(import.meta.url)
const { createFileWatcher } = require('../../electron/filewatcher.cjs') as {
  createFileWatcher: (deps: {
    onEvent: (info: { path: string; kind: 'change' | 'unlink' }) => void
  }) => {
    sync: (paths: unknown) => void
    noteWrite: (path: string, content: string) => void
    stop: () => void
    size: () => number
    knownOf: (path: string) => string | undefined
    DEBOUNCE_MS: number
  }
}

/** 等待事件出现（watcher 防抖 + fs 事件派发都有延迟，轮询直到超时） */
async function waitForEvent(
  events: { path: string; kind: 'change' | 'unlink' }[],
  pred: (info: { path: string; kind: 'change' | 'unlink' }) => boolean,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.some(pred)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return events.some(pred)
}

const dirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tmd-filewatcher-'))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('createFileWatcher', () => {
  it('外部写入触发 change 事件，自身 noteWrite 被指纹过滤', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'note.md')
    await writeFile(file, 'v1', 'utf-8')
    /** @type {{path: string, kind: 'change' | 'unlink'}[]} */
    const events: { path: string; kind: 'change' | 'unlink' }[] = []
    const w = createFileWatcher({ onEvent: (e) => events.push(e) })
    w.sync([file])
    // 基线读取是异步的：等指纹落定再测
    await new Promise((r) => setTimeout(r, 150))

    // 自身保存：写盘 + 登记新指纹 → 事件即使到达也按指纹被过滤
    await writeFile(file, 'v2-self', 'utf-8')
    w.noteWrite(file, 'v2-self')
    await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 400))
    expect(events.filter((e) => e.kind === 'change')).toEqual([])

    // 外部修改（未登记指纹）→ change
    await writeFile(file, 'v3-external', 'utf-8')
    expect(await waitForEvent(events, (e) => e.kind === 'change' && e.path === file)).toBe(true)
    w.stop()
  })

  it('文件被删除触发 unlink；集合收缩后停止监视', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'gone.md')
    await writeFile(file, 'content', 'utf-8')
    /** @type {{path: string, kind: 'change' | 'unlink'}[]} */
    const events: { path: string; kind: 'change' | 'unlink' }[] = []
    const w = createFileWatcher({ onEvent: (e) => events.push(e) })
    w.sync([file])
    await new Promise((r) => setTimeout(r, 150))
    expect(w.size()).toBe(1)

    await rm(path.dirname(file) === dir ? file : file)
    expect(await waitForEvent(events, (e) => e.kind === 'unlink')).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(w.size()).toBe(0)

    // 重新 sync 同一路径（文件已不存在）：watch 挂不上，不再计入门集
    w.sync([file])
    expect(w.size()).toBe(0)
    w.stop()
  })

  it('rename 式原子保存（临时文件替换）后仍能跟踪后续修改', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'atomic.md')
    await writeFile(file, 'original', 'utf-8')
    /** @type {{path: string, kind: 'change' | 'unlink'}[]} */
    const events: { path: string; kind: 'change' | 'unlink' }[] = []
    const w = createFileWatcher({ onEvent: (e) => events.push(e) })
    w.sync([file])
    await new Promise((r) => setTimeout(r, 150))

    // 模拟 VS Code 式原子保存：写临时文件再 rename 覆盖（旧 watcher 随 inode 失效）
    const tmp = file + '.tmp'
    await writeFile(tmp, 'atomic-1', 'utf-8')
    await rename(tmp, file)
    expect(await waitForEvent(events, (e) => e.kind === 'change')).toBe(true)

    // 原子保存后 watcher 已重建：继续修改仍能被发现
    // （不能用 waitForEvent 谓词等待——数组里已有旧 change 事件会立刻命中）
    const countBefore = events.filter((e) => e.kind === 'change').length
    await writeFile(file, 'atomic-2', 'utf-8')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (events.filter((e) => e.kind === 'change').length > countBefore) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(events.filter((e) => e.kind === 'change').length).toBeGreaterThan(countBefore)
    w.stop()
  })

  it('sync 差量增删：新增路径挂监视、移除路径清指纹', async () => {
    const dir = await makeTempDir()
    const a = path.join(dir, 'a.md')
    const b = path.join(dir, 'b.md')
    await writeFile(a, 'a', 'utf-8')
    await writeFile(b, 'b', 'utf-8')
    const w = createFileWatcher({ onEvent: () => {} })
    w.sync([a])
    await new Promise((r) => setTimeout(r, 120))
    expect(w.size()).toBe(1)
    expect(w.knownOf(a)).toBeTruthy()

    w.sync([a, b])
    await new Promise((r) => setTimeout(r, 120))
    expect(w.size()).toBe(2)
    expect(w.knownOf(b)).toBeTruthy()

    w.sync([b])
    expect(w.size()).toBe(1)
    expect(w.knownOf(a)).toBeUndefined()

    // 非法载荷：不是数组 / 重复路径 / 空串都被收敛
    w.sync('not-an-array')
    expect(w.size()).toBe(1)
    w.stop()
  })

  it('noteWrite 对未监视路径不登记（防止 Map 无界增长）', () => {
    const w = createFileWatcher({ onEvent: () => {} })
    w.noteWrite('/somewhere/never-watched.md', 'x')
    expect(w.knownOf('/somewhere/never-watched.md')).toBeUndefined()
    w.stop()
  })

  it('渲染层兜底口径：磁盘内容与内存一致时事件不改变结论（指纹快照）', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'echo.md')
    const content = 'same-content'
    await writeFile(file, content, 'utf-8')
    /** @type {{path: string, kind: 'change' | 'unlink'}[]} */
    const events: { path: string; kind: 'change' | 'unlink' }[] = []
    const w = createFileWatcher({ onEvent: (e) => events.push(e) })
    w.sync([file])
    await new Promise((r) => setTimeout(r, 150))

    // 主进程 noteWrite 过滤正常路径；即使漏登记（回声窗口），渲染层还会比对
    // 「磁盘内容 === tab.markdown」跳过——这里验证 noteWrite 后指纹确实更新
    await writeFile(file, content + '!', 'utf-8')
    w.noteWrite(file, content + '!')
    await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 400))
    expect(events.filter((e) => e.kind === 'change')).toEqual([])
    expect(await readFile(file, 'utf-8')).toBe(content + '!')
    expect(existsSync(file)).toBe(true)
    w.stop()
  })
})
