import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

// electron/ipc-files.cjs 是「工厂 + 依赖注入」模块（不 require electron），
// 可经 createRequire 直接加载，用假 ipcMain 捕获 handler 验证注册行为
// （与 exporter.test.ts 同范式）。这里锁住一个曾回归过的点：主题目录必须落在
// <tmdRoot>/.tmd/themes（与 logs / history / crash-dumps 同级、随 TMD_HOME_DIR
// 重定位），而不是遗漏 .tmd 段的 <tmdRoot>/themes。
const require = createRequire(import.meta.url)
const { registerFileIpc } = require('../../electron/ipc-files.cjs') as {
  registerFileIpc: (deps: Record<string, unknown>) => void
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

describe('ipc-files.cjs 主题 IPC 的目录解析', () => {
  it('themesList / themesOpenDir 均落在 <tmdRoot>/.tmd/themes（保留 .tmd 段）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-ipc-files-'))
    const prev = process.env.TMD_HOME_DIR
    process.env.TMD_HOME_DIR = root
    try {
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
    } finally {
      if (prev === undefined) delete process.env.TMD_HOME_DIR
      else process.env.TMD_HOME_DIR = prev
    }
  })
})
