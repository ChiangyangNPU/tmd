import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// electron/dirwatcher.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载验证目录监视的挂载/卸载与防抖合并
// （与 filewatcher.test.ts 同范式；fs.watch 通知平台相关，用轮询等待）。
const require = createRequire(import.meta.url)
const { createDirWatcher, DEBOUNCE_MS, MAX_WATCHERS } =
  require('../../electron/dirwatcher.cjs') as {
    createDirWatcher: (deps: { onChange: (dir: string) => void }) => {
      sync: (paths: unknown) => void
      stop: () => void
      size: () => number
    }
    DEBOUNCE_MS: number
    MAX_WATCHERS: number
  }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（超时返回最终状态） */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}

describe('dirwatcher', () => {
  it('目录内新建文件 / 子目录后回调该目录，且短窗口内的事件被防抖合并', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-dirw-'))
    const calls: string[] = []
    const w = createDirWatcher({ onChange: (dir) => calls.push(dir) })
    try {
      w.sync([root])
      await sleep(100) // 等底层 watcher 就绪（平台相关）
      await writeFile(path.join(root, 'a.md'), 'x')
      await writeFile(path.join(root, 'b.md'), 'x')
      await mkdir(path.join(root, 'sub'))
      expect(await waitFor(() => calls.length > 0)).toBe(true)
      expect(calls[0]).toBe(root)
      // 防抖窗口内的连续操作不应放大成多次刷新（允许平台补发一次）
      await sleep(DEBOUNCE_MS + 250)
      expect(calls.length).toBeLessThanOrEqual(2)
    } finally {
      w.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('从同步集合移除后不再回调', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-dirw-'))
    const calls: string[] = []
    const w = createDirWatcher({ onChange: (dir) => calls.push(dir) })
    try {
      w.sync([root])
      await sleep(100)
      await writeFile(path.join(root, 'a.md'), 'x')
      expect(await waitFor(() => calls.length > 0)).toBe(true)
      w.sync([]) // 卸载
      calls.length = 0
      await writeFile(path.join(root, 'b.md'), 'x')
      await sleep(DEBOUNCE_MS + 400)
      expect(calls.length).toBe(0)
    } finally {
      w.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('size 反映差量挂/卸，并容忍重复与不存在的路径', async () => {
    const a = await mkdtemp(path.join(tmpdir(), 'tmd-dirw-a-'))
    const b = await mkdtemp(path.join(tmpdir(), 'tmd-dirw-b-'))
    const w = createDirWatcher({ onChange: () => {} })
    try {
      w.sync([a, b])
      expect(w.size()).toBe(2)
      w.sync([a, a])
      expect(w.size()).toBe(1)
      // 不存在 / 非法路径：attach 失败静默，不抛错
      expect(() => w.sync([a, path.join(a, 'missing'), 42, null, ''])).not.toThrow()
      expect(w.size()).toBe(1)
      w.sync('not-an-array')
      expect(w.size()).toBe(1)
    } finally {
      w.stop()
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })

  it('监视数量上限与防抖窗口常量导出（主进程装配依赖）', () => {
    expect(MAX_WATCHERS).toBeGreaterThan(0)
    expect(DEBOUNCE_MS).toBeGreaterThanOrEqual(100)
  })
})
