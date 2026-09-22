import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUP_ORDER,
  SHORTCUTS_KEY,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
  eventToAccelerator,
  formatAccelerator,
  isValidShortcut,
  isModifierOnly,
  isSameAccelerator,
  findConflict,
} from '../shortcuts'

/**
 * 内存版 localStorage：setup.ts 的全局桩不支持读写往返，
 * 此处覆盖以便验证配置的保存/读取/重置链路。
 */
function installMemoryStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  })
  return map
}

/** 构造键盘事件（测试环境无 KeyboardEvent 构造器，按需字段强转） */
function keyEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  } as KeyboardEvent
}

describe('SHORTCUT_DEFS 快捷键定义', () => {
  it('action 唯一', () => {
    const actions = SHORTCUT_DEFS.map((d) => d.action)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('每项都有非空的 labelKey 与 default', () => {
    for (const def of SHORTCUT_DEFS) {
      expect(def.labelKey.length).toBeGreaterThan(0)
      expect(def.default.length).toBeGreaterThan(0)
    }
  })

  it('默认值均为合法快捷键（含 Ctrl/Cmd 或 Alt）', () => {
    for (const def of SHORTCUT_DEFS) {
      expect(isValidShortcut(def.default)).toBe(true)
    }
  })

  it('默认值互不冲突（同一组合键不能绑到两个动作）', () => {
    for (const a of SHORTCUT_DEFS) {
      for (const b of SHORTCUT_DEFS) {
        if (a.action >= b.action) continue
        expect(
          isSameAccelerator(a.default, b.default),
          `${a.action}(${a.default}) 与 ${b.action}(${b.default}) 默认快捷键重复`,
        ).toBe(false)
      }
    }
  })

  it('分组顺序覆盖所有出现过的分组', () => {
    const groups = new Set(SHORTCUT_DEFS.map((d) => d.group))
    for (const g of groups) {
      expect(SHORTCUT_GROUP_ORDER).toContain(g)
    }
  })

  it('覆盖渲染层全局快捷键（快速切换/查找/源码模式）', () => {
    const actions = SHORTCUT_DEFS.map((d) => d.action)
    expect(actions).toEqual(expect.arrayContaining(['quick-switch', 'find', 'source-mode']))
  })
})

describe('快捷键配置读写', () => {
  beforeEach(() => {
    installMemoryStorage()
    resetShortcuts()
  })

  it('无存储时返回全部默认值', () => {
    const shortcuts = loadShortcuts()
    for (const def of SHORTCUT_DEFS) {
      expect(shortcuts[def.action]).toBe(def.default)
    }
  })

  it('saveShortcuts 支持部分覆盖并保留其余默认值', () => {
    saveShortcuts({ 'fmt-bold': 'CmdOrCtrl+Alt+B' })
    const shortcuts = loadShortcuts()
    expect(shortcuts['fmt-bold']).toBe('CmdOrCtrl+Alt+B')
    expect(shortcuts['fmt-italic']).toBe('CmdOrCtrl+I')
  })

  it('多次 saveShortcuts 累积覆盖（增量合并）', () => {
    saveShortcuts({ 'fmt-bold': 'CmdOrCtrl+Alt+B' })
    saveShortcuts({ 'fmt-italic': 'CmdOrCtrl+Alt+I' })
    const shortcuts = loadShortcuts()
    expect(shortcuts['fmt-bold']).toBe('CmdOrCtrl+Alt+B')
    expect(shortcuts['fmt-italic']).toBe('CmdOrCtrl+Alt+I')
  })

  it('resetShortcuts 清除覆盖项恢复默认', () => {
    saveShortcuts({ 'fmt-bold': 'CmdOrCtrl+Alt+B' })
    resetShortcuts()
    expect(loadShortcuts()['fmt-bold']).toBe('CmdOrCtrl+B')
  })

  it('存储内容损坏时静默降级为默认值', () => {
    localStorage.setItem(SHORTCUTS_KEY, '{ not json')
    expect(loadShortcuts()['fmt-bold']).toBe('CmdOrCtrl+B')
  })

  it('忽略存储中不属于已知 action 的键', () => {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify({ 'unknown-action': 'CmdOrCtrl+X' }))
    const shortcuts = loadShortcuts()
    expect(shortcuts['unknown-action']).toBeUndefined()
    expect(shortcuts['fmt-bold']).toBe('CmdOrCtrl+B')
  })
})

describe('eventToAccelerator 按键转换', () => {
  it('Windows/Linux 下 Ctrl+字母 记为 CmdOrCtrl', () => {
    expect(eventToAccelerator(keyEvent('b', { ctrl: true }))).toBe('CmdOrCtrl+B')
  })

  it('包含 Shift 与 Alt', () => {
    expect(eventToAccelerator(keyEvent('k', { ctrl: true, shift: true }))).toBe('CmdOrCtrl+Shift+K')
    expect(eventToAccelerator(keyEvent('p', { ctrl: true, alt: true }))).toBe('CmdOrCtrl+Alt+P')
  })

  it('修饰键本身不作为主键（仅返回修饰符）', () => {
    expect(eventToAccelerator(keyEvent('Control', { ctrl: true }))).toBe('CmdOrCtrl')
    expect(eventToAccelerator(keyEvent('Shift', { ctrl: true, shift: true }))).toBe('CmdOrCtrl+Shift')
  })

  it('空格键规范化为 Space', () => {
    expect(eventToAccelerator(keyEvent(' ', { ctrl: true }))).toBe('CmdOrCtrl+Space')
  })
})

describe('isModifierOnly 修饰键判定', () => {
  it('仅修饰键组合为 true', () => {
    expect(isModifierOnly('CmdOrCtrl')).toBe(true)
    expect(isModifierOnly('CmdOrCtrl+Shift')).toBe(true)
    expect(isModifierOnly('')).toBe(true)
  })

  it('含主键的组合为 false', () => {
    expect(isModifierOnly('CmdOrCtrl+B')).toBe(false)
    expect(isModifierOnly('Alt+X')).toBe(false)
  })
})

describe('isValidShortcut 合法性校验', () => {
  it('含 Ctrl/Cmd 或 Alt 的组合合法', () => {
    expect(isValidShortcut('CmdOrCtrl+B')).toBe(true)
    expect(isValidShortcut('CmdOrCtrl+Shift+H')).toBe(true)
    expect(isValidShortcut('Alt+X')).toBe(true)
    expect(isValidShortcut('Ctrl+Q')).toBe(true)
  })

  it('仅含 Shift 或单字符不合法（会与正常输入冲突）', () => {
    expect(isValidShortcut('Shift+B')).toBe(false)
    expect(isValidShortcut('B')).toBe(false)
  })
})

describe('isSameAccelerator 冲突比较', () => {
  it('修饰键顺序不同视为相同', () => {
    expect(isSameAccelerator('CmdOrCtrl+Shift+B', 'Shift+CmdOrCtrl+B')).toBe(true)
  })

  it('不同组合视为不同', () => {
    expect(isSameAccelerator('CmdOrCtrl+B', 'CmdOrCtrl+Alt+B')).toBe(false)
    expect(isSameAccelerator('CmdOrCtrl+B', 'CmdOrCtrl+I')).toBe(false)
  })
})

describe('findConflict 冲突检测', () => {
  beforeEach(() => {
    installMemoryStorage()
    resetShortcuts()
  })

  it('命中其他 action 时返回该 action', () => {
    const shortcuts = loadShortcuts()
    expect(findConflict('CmdOrCtrl+I', 'fmt-bold', shortcuts)).toBe('fmt-italic')
  })

  it('与自身配置相同不算冲突（excludeAction）', () => {
    const shortcuts = loadShortcuts()
    expect(findConflict('CmdOrCtrl+B', 'fmt-bold', shortcuts)).toBeNull()
  })

  it('无冲突时返回 null', () => {
    const shortcuts = loadShortcuts()
    expect(findConflict('CmdOrCtrl+Alt+Shift+Z', 'fmt-bold', shortcuts)).toBeNull()
  })
})

describe('formatAccelerator 显示文本', () => {
  it('非 macOS 用加号连接', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+B')).toBe('Ctrl+Shift+B')
    expect(formatAccelerator('Ctrl+Q')).toBe('Ctrl+Q')
  })

  it('修饰键顺序统一为 Ctrl/Cmd → Shift → Alt，主键恒在最后', () => {
    // 配置里写成 Shift 在前时，显示仍统一为 Ctrl+Shift
    expect(formatAccelerator('Shift+CmdOrCtrl+O')).toBe('Ctrl+Shift+O')
    expect(formatAccelerator('Shift+CmdOrCtrl+H')).toBe('Ctrl+Shift+H')
    expect(formatAccelerator('Alt+Shift+CmdOrCtrl+X')).toBe('Ctrl+Shift+Alt+X')
    // 主键不会被排到修饰键之前
    expect(formatAccelerator('B+CmdOrCtrl+Shift')).toBe('Ctrl+Shift+B')
  })

  it('默认值书写顺序一致（Ctrl/Cmd 开头）', () => {
    for (const def of SHORTCUT_DEFS) {
      expect(def.default.split('+')[0]).toMatch(/^(CmdOrCtrl|CommandOrControl|Ctrl)$/)
    }
  })
})

describe('macOS 环境下的显示与映射（苹果 HIG 顺序 ⌃⌥⇧⌘）', () => {
  // 恢复 setup.ts 的默认桩，避免影响同文件内其他测试
  afterAll(() => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    vi.resetModules()
  })

  /** 以 macOS 的 userAgent 重新加载模块，使 IS_MAC 为 true */
  async function loadAsMac() {
    vi.resetModules()
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    return import('../shortcuts')
  }

  it('识别为 macOS 环境', async () => {
    const mac = await loadAsMac()
    expect(mac.IS_MAC).toBe(true)
  })

  it('修饰键按 ⌃⌥⇧⌘ 顺序显示，Shift 在 Command 之前', async () => {
    const mac = await loadAsMac()
    // 与系统菜单栏 / Finder / VS Code 的 ⇧⌘ 写法一致
    expect(mac.formatAccelerator('CmdOrCtrl+Shift+O')).toBe('⇧⌘O')
    expect(mac.formatAccelerator('Shift+CmdOrCtrl+O')).toBe('⇧⌘O')
    expect(mac.formatAccelerator('CmdOrCtrl+B')).toBe('⌘B')
    // Ctrl 单独出现时显示 ⌃，与 ⌘ 区分
    expect(mac.formatAccelerator('Ctrl+Q')).toBe('⌃Q')
    // 多修饰键按 ⌥⇧⌘ 顺序
    expect(mac.formatAccelerator('CmdOrCtrl+Alt+Shift+X')).toBe('⌥⇧⌘X')
  })

  it('Cmd 映射为 CmdOrCtrl、Ctrl 映射为 Ctrl（两者可区分）', async () => {
    const mac = await loadAsMac()
    expect(mac.eventToAccelerator(keyEvent('b', { meta: true }))).toBe('CmdOrCtrl+B')
    expect(mac.eventToAccelerator(keyEvent('b', { ctrl: true }))).toBe('Ctrl+B')
    expect(mac.eventToAccelerator(keyEvent('o', { meta: true, shift: true }))).toBe(
      'CmdOrCtrl+Shift+O',
    )
  })

  it('引用快捷键默认避开系统 ⌘Q（用 Ctrl+Q）', async () => {
    const mac = await loadAsMac()
    const quote = mac.SHORTCUT_DEFS.find((d) => d.action === 'fmt-quote')
    expect(quote?.default).toBe('Ctrl+Q')
  })
})
