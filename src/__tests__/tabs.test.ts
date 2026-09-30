/**
 * 标签页状态机：脏标记流转、关闭保护、激活暂存。
 *
 * 脏标记语义是关闭确认 / 自动保存 / 恢复副本清理的公共依赖（见 Fix2 回归），
 * 这里用内存桩把语义钉死。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../editor-core', () => ({
  replaceEditor: vi.fn(async () => {}),
  currentMarkdown: vi.fn(() => ''),
  destroyEditor: vi.fn(async () => {}),
}))
vi.mock('../image-resolver', () => ({
  setImageBaseDir: vi.fn(),
}))
vi.mock('../native', () => ({ native: undefined }))

import {
  newTab,
  listTabs,
  activeTab,
  markDirty,
  syncDirtyWith,
  hasDirty,
  activateTab,
  closeTab,
  isTabOpen,
} from '../tabs'
import { replaceEditor, currentMarkdown } from '../editor-core'
import { saveDoc, loadDoc } from '../store'

beforeEach(async () => {
  // tabs.ts 模块级状态无重置入口：逐个关闭标签回归空白态
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  vi.stubGlobal('document', {
    title: '',
    getElementById: () => null,
    querySelector: () => null,
  })
  // setup.ts 的 localStorage 桩是空操作：这里换成内存实现，恢复副本清理用例需要真实读写
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  })
  // 关掉所有遗留标签（confirm 恒 true，脏标签直接放弃）；须等队列排空，
  // 否则上一轮未完成的异步激活会串进下一个用例
  for (const t of [...listTabs()]) await closeTab(t.id)
  vi.clearAllMocks()
  vi.mocked(currentMarkdown).mockReturnValue('')
})

describe('syncDirtyWith 内容比对清脏', () => {
  it('内容与基准一致清脏，不一致置脏', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    markDirty()
    expect(tab.dirty).toBe(true)

    syncDirtyWith('A')
    expect(tab.dirty).toBe(false)

    syncDirtyWith('B')
    expect(tab.dirty).toBe(true)
  })

  it('空表格单元格 <br /> 占位不造成伪脏', async () => {
    const tab = newTab('a.md', '|a|<br />|', '/tmp/a.md')
    await activateTab(tab.id)
    // 空单元格占位规范化后为「| + 空格 + |」，两侧一致即不算修改
    syncDirtyWith('|a| |')
    expect(tab.dirty).toBe(false)
  })
})

describe('markDirty 单向置脏', () => {
  it('置脏当前标签', async () => {
    const tab = newTab('a.md', 'A')
    await activateTab(tab.id)
    markDirty()
    expect(activeTab()?.dirty).toBe(true)
    expect(hasDirty()).toBe(true)
  })
})

describe('closeTab 关闭保护', () => {
  it('脏标签：弹确认，确认放弃后关闭', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    markDirty()
    const confirm = vi.fn(() => true)
    vi.stubGlobal('window', { confirm })

    await closeTab(tab.id)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(listTabs().some((t) => t.id === tab.id)).toBe(false)
  })

  it('脏标签：取消确认则保留', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    markDirty()
    vi.stubGlobal('window', { confirm: vi.fn(() => false) })

    await closeTab(tab.id)

    expect(listTabs().some((t) => t.id === tab.id)).toBe(true)
  })

  it('干净标签：直接关闭不弹确认', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('window', { confirm })

    await closeTab(tab.id)

    expect(confirm).not.toHaveBeenCalled()
    expect(listTabs().some((t) => t.id === tab.id)).toBe(false)
  })
})

describe('activateTab 切换暂存', () => {
  it('切走时把当前编辑器内容暂存到原标签', async () => {
    const a = newTab('a.md', 'A-old', '/tmp/a.md')
    const b = newTab('b.md', 'B', '/tmp/b.md')
    await activateTab(a.id)
    vi.mocked(currentMarkdown).mockReturnValue('A-dirty')
    await activateTab(b.id)
    expect(a.markdown).toBe('A-dirty')
    expect(vi.mocked(replaceEditor)).toHaveBeenLastCalledWith('B', expect.anything())
  })
})

describe('isTabOpen 与放弃标签的恢复副本清理', () => {
  it('关闭后 isTabOpen 为假（保存队列存活校验依赖）', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    expect(isTabOpen(tab)).toBe(true)
    await closeTab(tab.id)
    expect(isTabOpen(tab)).toBe(false)
  })

  it('放弃脏标签时一并清除属于它的恢复副本', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    markDirty()
    vi.mocked(currentMarkdown).mockReturnValue('A-latest')
    saveDoc('A-latest')
    expect(loadDoc()).toBe('A-latest')

    await closeTab(tab.id) // confirm 默认 true = 放弃

    expect(loadDoc()).toBeNull()
  })

  it('副本内容与该标签不一致时保留副本（可能属于其他标签）', async () => {
    const tab = newTab('a.md', 'A', '/tmp/a.md')
    await activateTab(tab.id)
    markDirty()
    vi.mocked(currentMarkdown).mockReturnValue('A-latest')
    saveDoc('OTHER-TAB-CONTENT')

    await closeTab(tab.id)

    expect(loadDoc()).toBe('OTHER-TAB-CONTENT')
  })
})
