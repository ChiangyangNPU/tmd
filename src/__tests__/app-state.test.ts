import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// electron/app-state.cjs 是纯 Node CJS 模块（仅依赖 menu.cjs 的默认文案表），
// 经 createRequire 直接加载验证共享状态 store 的读写语义（与 menu.test.ts 同范式）：
// 主进程侧 main / ipc-app / ipc-files / updater / recent 都 require 本模块共享状态，
// 契约漂移不会在渲染层单测中暴露，故在此把默认值与访问约定钉住。
const require = createRequire(import.meta.url)
const state = require('../../electron/app-state.cjs') as {
  SHELL_BG: { dark: string; light: string }
  getMainWindow: () => { id: number } | null
  setMainWindow: (win: { id: number } | null) => void
  isRendererDirty: () => boolean
  setRendererDirty: (dirty: boolean) => void
  isAutosaveEnabled: () => boolean
  setAutosaveEnabled: (enabled: boolean) => void
  getMenuLabels: () => Record<string, string>
  setMenuLabels: (labels: Record<string, string>) => void
  getCustomShortcuts: () => Record<string, string>
  setCustomShortcuts: (shortcuts: Record<string, string>) => void
  getSortLocale: () => string
  setSortLocale: (locale: string) => void
  getShellThemeSource: () => 'system' | 'dark' | 'light'
  setShellThemeSource: (source: 'system' | 'dark' | 'light') => void
}
const { DEFAULT_MENU_LABELS } = require('../../electron/menu.cjs') as {
  DEFAULT_MENU_LABELS: Record<string, string>
}

// 模块是进程内单例，测试间共享可变状态；默认值在加载时先快照，
// 使「初始默认值」断言不受本文件后续用例的写操作影响
const defaults = {
  mainWindow: state.getMainWindow(),
  rendererDirty: state.isRendererDirty(),
  autosaveEnabled: state.isAutosaveEnabled(),
  menuLabels: state.getMenuLabels(),
  customShortcuts: state.getCustomShortcuts(),
  sortLocale: state.getSortLocale(),
  shellThemeSource: state.getShellThemeSource(),
}

describe('app-state.cjs 共享状态 store', () => {
  it('模块加载时默认值与设计一致（渲染层同步前的兜底）', () => {
    expect(defaults.mainWindow).toBeNull()
    expect(defaults.rendererDirty).toBe(false)
    expect(defaults.autosaveEnabled).toBe(false)
    // 默认文案与 menu.cjs 内容一致但非同一引用：setLocaleInfo 合并新表时不会污染默认表
    expect(defaults.menuLabels).toEqual(DEFAULT_MENU_LABELS)
    expect(defaults.menuLabels).not.toBe(DEFAULT_MENU_LABELS)
    expect(defaults.customShortcuts).toEqual({})
    expect(defaults.sortLocale).toBe('')
    expect(defaults.shellThemeSource).toBe('system')
  })

  it('模块为进程内单例：多处 require 到同一份状态', () => {
    // main.cjs 与 ipc-app/updater 等模块各自 require，必须命中同一实例，
    // 否则「渲染层经 IPC 写入的状态、窗口生命周期读到的却是旧值」
    const again = require('../../electron/app-state.cjs') as typeof state
    expect(again).toBe(state)
    state.setSortLocale('zh-CN')
    expect(again.getSortLocale()).toBe('zh-CN')
    state.setSortLocale('')
  })

  it('主窗口引用：set/get 往返与 closed 后置空', () => {
    const win = { id: 1 }
    state.setMainWindow(win)
    expect(state.getMainWindow()).toBe(win)
    state.setMainWindow(null)
    expect(state.getMainWindow()).toBeNull()
  })

  it('布尔入参经 !! 收窄：非布尔写入也落为布尔（IPC 入参不可信）', () => {
    state.setRendererDirty(1 as unknown as boolean)
    expect(state.isRendererDirty()).toBe(true)
    state.setRendererDirty(0 as unknown as boolean)
    expect(state.isRendererDirty()).toBe(false)
    state.setAutosaveEnabled('x' as unknown as boolean)
    expect(state.isAutosaveEnabled()).toBe(true)
    state.setAutosaveEnabled(null as unknown as boolean)
    expect(state.isAutosaveEnabled()).toBe(false)
  })

  it('getter 取值即取引用：替换后的新对象立即可见（禁止解构快照的约定）', () => {
    const labels = { open: 'Open' }
    state.setMenuLabels(labels)
    expect(state.getMenuLabels()).toBe(labels)
    // set 是整体替换而非合并（与 DEFAULT_MENU_LABELS 的合并职责在 ipc-app 侧）；
    // getter 每次取值拿到当前引用，解构快照会读到旧对象
    const next = { open: '打开' }
    state.setMenuLabels(next)
    expect(state.getMenuLabels()).not.toBe(labels)
    expect(state.getMenuLabels()).toBe(next)

    const shortcuts = { open: 'CmdOrCtrl+E' }
    state.setCustomShortcuts(shortcuts)
    expect(state.getCustomShortcuts()).toBe(shortcuts)
  })

  it('排序区域与主题来源的读写', () => {
    state.setSortLocale('zh-TW')
    expect(state.getSortLocale()).toBe('zh-TW')
    state.setSortLocale('')

    state.setShellThemeSource('dark')
    expect(state.getShellThemeSource()).toBe('dark')
    state.setShellThemeSource('light')
    expect(state.getShellThemeSource()).toBe('light')
    state.setShellThemeSource('system')
  })

  it('窗口底色常量与渲染层 --bg 对齐（合成层兜底色）', () => {
    expect(state.SHELL_BG).toEqual({ dark: '#1e2127', light: '#ffffff' })
  })
})
