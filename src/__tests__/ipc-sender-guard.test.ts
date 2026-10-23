import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// 用假 ipcMain 直接注册各主进程模块，锁住 19 条敏感通道的 sender 校验接线：
// 后续改动某个 handler 时若漏掉 assertMainWindow，这里会逐通道报出具体名字。
// （app-state.test.ts 已验证 assertMainWindow 本身；ipc-files.test.ts 覆盖 saveFile
// 的放行方向；本文件只做「外来 sender 一律 forbidden」的接线回归。）
const require = createRequire(import.meta.url)
const state = require('../../electron/app-state.cjs') as {
  setMainWindow: (win: unknown) => void
}
const { registerFileIpc } = require('../../electron/ipc-files.cjs') as {
  registerFileIpc: (deps: Record<string, unknown>) => void
}
const { registerAppIpc } = require('../../electron/ipc-app.cjs') as {
  registerAppIpc: (deps: Record<string, unknown>) => void
}
const { createPicGo } = require('../../electron/picgo.cjs') as {
  createPicGo: (deps: Record<string, unknown>) => { register: () => void }
}
const { createUpdater } = require('../../electron/updater.cjs') as {
  createUpdater: (deps: Record<string, unknown>) => { registerIpc: () => void }
}
const { registerAiIpc } = require('../../electron/ipc-ai.cjs') as {
  registerAiIpc: (deps: Record<string, unknown>) => void
}
const IPC = require('../../electron/ipc.cjs') as Record<string, string>

/** 注册主进程各领域模块的全部 IPC，返回 channel → handler */
function registerAll() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    once: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  }

  registerFileIpc({
    ipcMain,
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    app: { getLocale: () => 'zh-CN' },
    IPC,
    fileWatcher: { noteWrite: () => {}, sync: () => {} },
    logger: { log: () => {} },
    showOpenDialogSafe: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialogSafe: async () => ({ canceled: true }),
  })

  registerAppIpc({
    ipcMain,
    nativeTheme: { themeSource: 'system' },
    shell: { openExternal: async () => {}, openPath: async () => '' },
    IPC,
    saveShellState: () => {},
    rebuildMenu: () => {},
    flushPendingOpenPaths: () => {},
    getAutosaveMenuItem: () => null,
  })

  createPicGo({
    ipcMain,
    IPC,
    app: { getPath: () => '/tmp' },
    PicGo: class {},
  }).register()

  createUpdater({
    autoUpdater: {
      on: () => {},
      setFeedURL: () => {},
      checkForUpdates: async () => {},
      downloadUpdate: async () => {},
      quitAndInstall: () => {},
    },
    ipcMain,
    shell: { openPath: async () => '' },
    app: { getPath: () => '/tmp', quit: () => {} },
    getDefaultSession: () => ({}),
    IPC,
    sendToRenderer: () => {},
    showMessageBoxSafe: async () => ({ response: 1 }),
    clearRendererRecoveryCopy: async () => {},
  }).registerIpc()

  // AI 助手：配置含加密 Key 路径、对话属于网络外发，全部通道都在守卫范围内
  registerAiIpc({
    ipcMain,
    IPC,
    aiConfig: {
      read: () => ({ enabled: true }),
      publicView: () => ({}),
      save: () => ({}),
      getClientConfig: () => ({}),
    },
    aiClient: {
      chat: async () => ({ content: '' }),
      test: async () => ({ ok: true, latencyMs: 0 }),
      abort: () => false,
    },
    sendToRenderer: () => {},
  })

  return handlers
}

describe('敏感 IPC 的 sender 校验接线', () => {
  it('19 条通道均拒绝非主窗口 sender（漏接 assertMainWindow 时逐条报名字）', async () => {
    const handlers = registerAll()
    const mainWc = { id: 'main-web-contents' }
    const foreignWc = { id: 'foreign-web-contents' }
    state.setMainWindow({ isDestroyed: () => false, webContents: mainWc })
    try {
      /** channel → 最小合法入参（守卫在入参校验之前，值本身不会被执行） */
      const cases: Array<[string, unknown[]]> = [
        [IPC.saveFile, ['/tmp/x.md', '# x']],
        [IPC.saveFileAs, ['# x', 'x.md']],
        [IPC.createFile, ['/tmp', 'x.md']],
        [IPC.createDir, ['/tmp', 'folder']],
        [IPC.renamePath, ['/tmp/x.md', 'y.md']],
        [IPC.revealInFolder, ['/tmp/x.md']],
        [IPC.exportAs, [{ content: '<p>x</p>', defaultName: 'x.html', filters: [] }]],
        [IPC.saveImage, [{ dir: '/tmp', name: 'a.png', base64: 'AA==' }]],
        [IPC.openExternal, ['https://example.com']],
        [IPC.openLocalFile, ['/tmp/x.md']],
        [IPC.uploadImage, ['AA==', '.png']],
        [IPC.savePicGoConfig, [{ current: 'smms' }]],
        [IPC.updateDownload, []],
        [IPC.updateInstall, []],
        [IPC.aiGetConfig, []],
        [IPC.aiSaveConfig, [{ enabled: true }]],
        [IPC.aiTest, [{}]],
        [IPC.aiChat, [{ requestId: 'r', messages: [{ role: 'user', content: 'hi' }] }]],
        [IPC.aiAbort, ['r']],
      ]
      expect(cases).toHaveLength(19)

      for (const [channel, args] of cases) {
        const fn = handlers.get(channel)
        if (!fn) throw new Error(`${channel}: handler 未注册`)
        let thrown: unknown = null
        try {
          await fn({ sender: foreignWc }, ...args)
        } catch (err) {
          thrown = err
        }
        if (!(thrown instanceof Error) || thrown.message !== 'forbidden') {
          throw new Error(`${channel}: 未拒绝外来 sender（实际 ${String(thrown)}）`)
        }
      }
    } finally {
      state.setMainWindow(null)
    }
  })
})
