/**
 * 保存流程状态机：基准（tab.markdown）只在写盘成功后推进。
 *
 * 回归背景：基准曾在捕获时推进，写盘失败 / 另存取消后基准已前移，用户撤销回
 * 原内容会被 syncDirtyWith 清脏（磁盘还是旧内容），关闭确认与自动保存随之失效。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 依赖全部打桩：只测 files.ts 自身的基准 / 脏标记 / 队列语义
vi.mock('../native', () => ({
  native: {
    saveFile: vi.fn(),
    saveFileAs: vi.fn(),
    openFile: vi.fn(),
    readFile: vi.fn(),
    recentAdd: vi.fn(),
  },
}))
vi.mock('../editor-core', () => ({
  currentMarkdown: vi.fn(),
  replaceEditor: vi.fn(),
}))
vi.mock('../tabs', () => ({
  activeTab: vi.fn(),
  activateTab: vi.fn(),
  newTab: vi.fn(),
  renderTabs: vi.fn(),
  updateTitle: vi.fn(),
  findByPath: vi.fn(() => undefined),
  blankTab: vi.fn(() => undefined),
  hasDirty: vi.fn(() => false),
  syncDirtyWith: vi.fn(),
}))
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>()
  return {
    ...actual,
    pushRecent: vi.fn(),
    recentList: vi.fn(() => []),
    clearRecent: vi.fn(),
    removeRecent: vi.fn(),
    clearDoc: vi.fn(),
    folderList: vi.fn(() => []),
    pushFolder: vi.fn(),
    removeFolder: vi.fn(),
    clearFolders: vi.fn(),
  }
})
vi.mock('../filetree', () => ({
  renderRecent: vi.fn(),
  renderFolders: vi.fn(),
}))

import { saveDocument } from '../files'
import { native } from '../native'
import { currentMarkdown } from '../editor-core'
import { activeTab, hasDirty, syncDirtyWith } from '../tabs'
import { clearDoc } from '../store'

const mocked = {
  save: vi.mocked(native!.saveFile),
  saveAs: vi.mocked(native!.saveFileAs),
  md: vi.mocked(currentMarkdown),
  activeTab: vi.mocked(activeTab),
  hasDirty: vi.mocked(hasDirty),
  syncDirtyWith: vi.mocked(syncDirtyWith),
  clearDoc: vi.mocked(clearDoc),
}

/** 测试环境无 DOM：showToast / 浏览器下载路径只触到这层表面 */
beforeEach(() => {
  vi.stubGlobal('document', {
    title: '',
    body: { appendChild: () => {} },
    createElement: () => ({ click: () => {} }),
    getElementById: () => null,
    querySelector: () => null,
  })
  vi.clearAllMocks()
  mocked.hasDirty.mockReturnValue(false)
})

function makeTab(overrides: Partial<{ path?: string; markdown: string; dirty: boolean }> = {}) {
  return { id: 'tab-1', name: 'a.md', path: '/tmp/a.md', markdown: 'OLD', dirty: true, ...overrides }
}

describe('saveDocument 基准推进语义', () => {
  it('写盘成功：基准推进到落盘内容，按当前内容同步脏标记，无脏清恢复副本', async () => {
    const tab = makeTab()
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValue('NEW')
    mocked.save.mockResolvedValue(true)

    await saveDocument()

    expect(mocked.save).toHaveBeenCalledWith('/tmp/a.md', 'NEW')
    expect(tab.markdown).toBe('NEW')
    expect(mocked.syncDirtyWith).toHaveBeenCalledWith('NEW')
    expect(mocked.clearDoc).toHaveBeenCalled()
  })

  it('写盘失败：基准不推进、脏比对不执行、恢复副本保留', async () => {
    const tab = makeTab()
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValue('NEW')
    mocked.save.mockRejectedValue(new Error('EACCES'))
    mocked.hasDirty.mockReturnValue(true)
    await saveDocument()

    expect(tab.markdown).toBe('OLD')
    expect(mocked.syncDirtyWith).not.toHaveBeenCalled()
    expect(mocked.clearDoc).not.toHaveBeenCalled()
  })

  it('另存取消：基准不推进、恢复副本保留', async () => {
    const tab = makeTab({ path: undefined })
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValue('NEW')
    mocked.saveAs.mockResolvedValue(null)
    mocked.hasDirty.mockReturnValue(true)

    await saveDocument(true)

    expect(mocked.saveAs).toHaveBeenCalledWith('NEW')
    expect(tab.markdown).toBe('OLD')
    expect(mocked.clearDoc).not.toHaveBeenCalled()
  })

  it('另存成功：路径与展示名更新、基准推进', async () => {
    const tab = makeTab({ path: undefined })
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValue('NEW')
    mocked.saveAs.mockResolvedValue({ path: '/tmp/b.md', name: 'b.md' })

    await saveDocument(true)

    expect(tab.path).toBe('/tmp/b.md')
    expect(tab.name).toBe('b.md')
    expect(tab.markdown).toBe('NEW')
    expect(mocked.syncDirtyWith).toHaveBeenCalledWith('NEW')
  })

  it('落盘期间继续输入：基准是落盘内容，脏比对取落盘后的实时内容', async () => {
    const tab = makeTab()
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValueOnce('NEW').mockReturnValueOnce('NEW2')
    mocked.save.mockImplementation(async () => {
      // 写盘期间用户又输入了内容
      mocked.md.mockReturnValue('NEW2')
      return true
    })

    await saveDocument()

    expect(tab.markdown).toBe('NEW')
    // 实时内容 NEW2 ≠ 落盘内容 NEW → 脏标记不得被清（syncDirtyWith 收到实时内容）
    expect(mocked.syncDirtyWith).toHaveBeenCalledWith('NEW2')
  })
})

describe('saveDocument 捕获与队列语义', () => {
  it('连续两次保存各自捕获调用时刻的内容，按序串行写盘', async () => {
    const tab = makeTab()
    mocked.activeTab.mockReturnValue(tab)
    mocked.md.mockReturnValue('V1')
    const writeOrder: string[] = []
    mocked.save.mockImplementation(async (_p, md) => {
      writeOrder.push(md)
      return true
    })

    const first = saveDocument()
    mocked.md.mockReturnValue('V2')
    const second = saveDocument()
    await Promise.all([first, second])

    expect(writeOrder).toEqual(['V1', 'V2'])
    expect(tab.markdown).toBe('V2')
  })
})
