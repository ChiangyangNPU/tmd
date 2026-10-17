import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

// electron/ipc-files.cjs 是「工厂 + 依赖注入」模块（不 require electron），
// 可经 createRequire 直接加载，用假 ipcMain 捕获 handler 验证注册行为
// （与 exporter.test.ts 同范式）。这里锁住四个曾回归/易回归的点：
// 1. 主题目录必须落在 <tmdRoot>/.tmd/themes（而非漏掉 .tmd 段的 <tmdRoot>/themes）；
// 2. v0.1.0–v0.1.3 误写到 <tmdRoot>/themes 的老主题会在首次访问时补拷；
// 3. 敏感写盘通道只放行主窗口 sender，且 readFile 拒绝非普通文件；
// 4. GBK + CRLF 文档读取时返回编码元信息，保存时按原编码/换行写回。
const require = createRequire(import.meta.url)
const iconv = require('iconv-lite') as {
  encode: (text: string, encoding: string) => Buffer
  decode: (buffer: Buffer, encoding: string) => string
}
const { registerFileIpc } = require('../../electron/ipc-files.cjs') as {
  registerFileIpc: (deps: Record<string, unknown>) => void
}
const state = require('../../electron/app-state.cjs') as {
  setMainWindow: (win: unknown) => void
}
const IPC = require('../../electron/ipc.cjs') as Record<string, string>

/** 以假 ipcMain 注册全部文件 IPC，返回 channel → handler 的映射 */
function registerWithFakeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerFileIpc({
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    },
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    app: { getLocale: () => 'zh-CN' },
    IPC,
    fileWatcher: { noteWrite: () => {}, sync: () => {} },
    logger: { log: () => {} },
    showOpenDialogSafe: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialogSafe: async () => ({ canceled: true }),
  })
  return handlers
}

/** 在 TMD_HOME_DIR 指向独立临时目录的环境下执行（registerFileIpc 时读取） */
async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'tmd-ipc-files-'))
  const prev = process.env.TMD_HOME_DIR
  process.env.TMD_HOME_DIR = root
  try {
    return await fn(root)
  } finally {
    if (prev === undefined) delete process.env.TMD_HOME_DIR
    else process.env.TMD_HOME_DIR = prev
    await rm(root, { recursive: true, force: true })
  }
}

describe('ipc-files.cjs 主题 IPC 的目录解析', () => {
  it('themesList / themesRead / themesOpenDir 均落在 <tmdRoot>/.tmd/themes（保留 .tmd 段）', async () => {
    await withTempHome(async (root) => {
      const handlers = registerWithFakeIpc()
      const expectedDir = path.join(root, '.tmd', 'themes')

      const listed = (await handlers.get(IPC.themesList)?.()) as {
        dir: string
        themes: unknown[]
      }
      expect(listed.dir).toBe(expectedDir)
      expect(listed.themes).toEqual([])

      // 打开主题目录会 mkdir + 空目录写入示例主题，顺带验证实际落盘位置
      const opened = await handlers.get(IPC.themesOpenDir)?.()
      expect(opened).toBe(true)
      expect(existsSync(path.join(expectedDir, '示例主题.css'))).toBe(true)

      // themesRead 同样从新目录读取（曾与 list/open 一起漏掉 .tmd 段）
      const css = await handlers.get(IPC.themesRead)?.({}, '示例主题.css')
      expect(css).toContain('--bg')
    })
  })

  it('旧版本 <tmdRoot>/themes 的 CSS 在首次访问时补拷到 .tmd/themes', async () => {
    await withTempHome(async (root) => {
      const legacyDir = path.join(root, 'themes')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(path.join(legacyDir, '旧主题.css'), ':root { --bg: red; }')

      const handlers = registerWithFakeIpc()
      const expectedDir = path.join(root, '.tmd', 'themes')
      const listed = (await handlers.get(IPC.themesList)?.()) as {
        dir: string
        themes: { name: string }[]
      }
      expect(listed.dir).toBe(expectedDir)
      expect(listed.themes).toEqual([{ name: '旧主题.css' }])
      expect(existsSync(path.join(expectedDir, '旧主题.css'))).toBe(true)

      // 迁移后启动时的 restoreFileTheme（themesRead）能读到老主题
      expect(await handlers.get(IPC.themesRead)?.({}, '旧主题.css')).toBe(':root { --bg: red; }')
    })
  })
})

describe('ipc-files.cjs 敏感 IPC 的 sender 校验', () => {
  it('saveFile 仅放行主窗口 webContents，外来 sender 一律 forbidden', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-ipc-files-guard-'))
    const webContents = { id: 'main-web-contents' }
    state.setMainWindow({ isDestroyed: () => false, webContents })
    try {
      const handlers = registerWithFakeIpc()
      const save = handlers.get(IPC.saveFile) as unknown as (
        event: unknown,
        filePath: string,
        content: string,
      ) => Promise<unknown>
      const target = path.join(root, 'guard.md')

      await expect(save({ sender: { id: 'foreign' } }, target, '# x')).rejects.toThrow('forbidden')
      expect(existsSync(target)).toBe(false)

      await expect(save({ sender: webContents }, target, '# x')).resolves.toBe(true)
      expect(await readFile(target, 'utf-8')).toBe('# x')
    } finally {
      state.setMainWindow(null)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ipc-files.cjs readFile 的类型校验', () => {
  it('拒绝目录等非普通文件（size 为 0 的流式路径不能绕过 50MB 上限）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-ipc-files-read-'))
    try {
      const handlers = registerWithFakeIpc()
      const read = handlers.get(IPC.readFile) as unknown as (
        event: unknown,
        filePath: string,
      ) => Promise<unknown>
      await expect(read({}, root)).rejects.toThrow('not a regular file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ipc-files.cjs 编码/换行保持', () => {
  it('GBK + CRLF 文档读取元信息，保存按原编码/换行写回', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-ipc-files-encoding-'))
    const webContents = { id: 'main-wc' }
    state.setMainWindow({ isDestroyed: () => false, webContents })
    try {
      const file = path.join(root, 'gbk.md')
      await writeFile(file, iconv.encode('中文\r\n内容\r\n', 'gbk'))
      const handlers = registerWithFakeIpc()
      const read = handlers.get(IPC.readFile) as unknown as (
        event: unknown,
        filePath: string,
      ) => Promise<{ content: string; encoding: string; bom: boolean; lineEnding: string }>
      const data = await read({}, file)
      expect(data).toMatchObject({
        content: '中文\r\n内容\r\n',
        encoding: 'gbk',
        bom: false,
        lineEnding: 'crlf',
      })

      const save = handlers.get(IPC.saveFile) as unknown as (
        event: unknown,
        filePath: string,
        content: string,
        meta: unknown,
      ) => Promise<unknown>
      await save({ sender: webContents }, file, '改后\r\n内容\r\n', {
        encoding: 'gbk',
        bom: false,
        lineEnding: 'crlf',
      })
      expect(iconv.decode(await readFile(file), 'gbk')).toBe('改后\r\n内容\r\n')
    } finally {
      state.setMainWindow(null)
      await rm(root, { recursive: true, force: true })
    }
  })
})
