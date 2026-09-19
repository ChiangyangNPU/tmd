import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// electron/menu.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载验证菜单模板结构（与 logger.test.ts 同范式）：
// 文案/快捷键/最近文件/自动保存/平台差异均注入，模板为纯数据可断言。
const require = createRequire(import.meta.url)
const { DEFAULT_MENU_LABELS, buildMenuTemplate } = require('../../electron/menu.cjs') as {
  DEFAULT_MENU_LABELS: Record<string, string>
  buildMenuTemplate: (deps: unknown) => MenuItemLike[]
}

/** 菜单模板项的测试投影（Electron MenuItemConstructorOptions 的最小子集） */
interface MenuItemLike {
  label?: string
  role?: string
  submenu?: MenuItemLike[]
  accelerator?: string
  type?: string
  checked?: boolean
  enabled?: boolean
  click?: (item: { checked: boolean }) => void
}

/** 组装最小依赖（labels 用中文默认表），按需覆盖 */
function build(overrides: Record<string, unknown> = {}, labels = DEFAULT_MENU_LABELS) {
  const calls = { actions: [] as string[], recents: [] as string[], autosave: [] as boolean[] }
  const template = buildMenuTemplate({
    labels,
    shortcuts: {},
    recents: [],
    autosaveEnabled: false,
    isMac: false,
    onAction: (a: string) => calls.actions.push(a),
    onRecentOpen: (p: string) => calls.recents.push(p),
    onAutosaveToggle: (v: boolean) => calls.autosave.push(v),
    ...overrides,
  })
  return { template, calls }
}

/** 在子菜单里按 label 找菜单项 */
function findItem(template: MenuItemLike[], label: string): MenuItemLike | undefined {
  for (const item of template) {
    if (item.label === label) return item
    if (item.submenu && Array.isArray(item.submenu)) {
      const hit = findItem(item.submenu, label)
      if (hit) return hit
    }
  }
  return undefined
}

describe('menu.cjs buildMenuTemplate', () => {
  it('文件菜单：默认 accelerator 与动作分发', () => {
    const { template, calls } = build()
    const open = findItem(template, '打开')
    expect(open?.accelerator).toBe('CmdOrCtrl+O')
    open?.click?.({ checked: false })
    expect(calls.actions).toEqual(['open'])
  })

  it('用户自定义快捷键覆盖默认值', () => {
    const { template } = build({ shortcuts: { open: 'CmdOrCtrl+E' } })
    expect(findItem(template, '打开')?.accelerator).toBe('CmdOrCtrl+E')
    // 未自定义的动作仍用默认值
    expect(findItem(template, '保存')?.accelerator).toBe('CmdOrCtrl+S')
  })

  it('最近文件：空列表为禁用占位项', () => {
    const { template } = build()
    const submenu = findItem(template, '打开最近文件')?.submenu ?? []
    expect(submenu).toEqual([{ label: '（无最近文件）', enabled: false }])
  })

  it('最近文件：条目 + 分隔线 + 清空项，点击分发对应回调', () => {
    const { template, calls } = build({
      recents: [
        { path: '/a.md', name: 'a.md' },
        { path: '/b.md', name: 'b.md' },
      ],
    })
    const submenu = findItem(template, '打开最近文件')?.submenu ?? []
    expect(submenu.map((s) => s.label ?? 'sep')).toEqual(['a.md', 'b.md', 'sep', '清空最近文件'])
    submenu[0]?.click?.({ checked: false })
    expect(calls.recents).toEqual(['/a.md'])
    submenu[3]?.click?.({ checked: false })
    expect(calls.actions).toEqual(['clear-recent'])
  })

  it('自动保存：checkbox 状态与切换回调', () => {
    const { template, calls } = build({ autosaveEnabled: true })
    const item = findItem(template, '自动保存到文件')
    expect(item?.type).toBe('checkbox')
    expect(item?.checked).toBe(true)
    item?.click?.({ checked: false })
    expect(calls.autosave).toEqual([false])
  })

  it('平台差异：Windows 无 appMenu、以 quit 收尾、引用为 CmdOrCtrl+Q', () => {
    const { template } = build({ isMac: false })
    expect(template[0]?.role).toBeUndefined()
    expect(template[0]?.label).toBe('文件')
    const fileSubmenu = template[0]?.submenu ?? []
    expect(fileSubmenu[fileSubmenu.length - 1]?.role).toBe('quit')
    expect(findItem(template, '引用')?.accelerator).toBe('CmdOrCtrl+Q')
  })

  it('平台差异：mac 有 appMenu、以 close 收尾、引用避让 Cmd+Q 改 Ctrl+Q', () => {
    const { template } = build({ isMac: true })
    expect(template[0]?.role).toBe('appMenu')
    const fileSubmenu = template[1]?.submenu ?? []
    expect(fileSubmenu[fileSubmenu.length - 1]?.role).toBe('close')
    expect(findItem(template, '引用')?.accelerator).toBe('Ctrl+Q')
  })

  it('导出菜单：Word / 长图不绑快捷键（离屏渲染重任务防误触）', () => {
    const { template } = build()
    expect(findItem(template, '导出 HTML')?.accelerator).toBe('CmdOrCtrl+Shift+H')
    expect(findItem(template, '导出 Word')?.accelerator).toBeUndefined()
    expect(findItem(template, '导出长图')?.accelerator).toBeUndefined()
  })

  it('格式菜单：标题 1-6 映射快捷键与 fmt-h* 动作', () => {
    const { template, calls } = build()
    const numerals = ['', '一', '二', '三', '四', '五', '六']
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const item = findItem(template, `${numerals[level]}级标题`)
      expect(item?.accelerator).toBe(`CmdOrCtrl+${level}`)
      item?.click?.({ checked: false })
    }
    expect(calls.actions).toEqual(['fmt-h1', 'fmt-h2', 'fmt-h3', 'fmt-h4', 'fmt-h5', 'fmt-h6'])
  })
})
