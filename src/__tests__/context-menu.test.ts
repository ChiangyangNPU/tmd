import { describe, it, expect } from 'vitest'
import { resolveMenuEntries } from '../context-menu'

describe('resolveMenuEntries（所见即所得侧）', () => {
  it('无选区仅显示粘贴', () => {
    expect(resolveMenuEntries(false, false)).toEqual(['paste'])
  })

  it('有选区显示剪切/复制/粘贴与内联格式组', () => {
    const entries = resolveMenuEntries(true, false)
    expect(entries).toEqual(['cut', 'copy', 'paste', 'bold', 'italic', 'strike', 'code', 'link'])
  })

  it('选区已带链接时，链接项切换为移除链接', () => {
    const entries = resolveMenuEntries(true, true)
    expect(entries).toContain('remove-link')
    expect(entries).not.toContain('link')
  })

  it('首项为剪切、末项为链接组，保持固定顺序', () => {
    const entries = resolveMenuEntries(true, true)
    expect(entries[0]).toBe('cut')
    expect(entries[entries.length - 1]).toBe('remove-link')
  })
})

describe('resolveMenuEntries（源码侧）', () => {
  it('可编辑且有选区：仅剪切/复制/粘贴（格式化为 ProseMirror 专属，不显示）', () => {
    expect(resolveMenuEntries(true, true, 'source')).toEqual(['cut', 'copy', 'paste'])
  })

  it('可编辑且无选区：仅粘贴', () => {
    expect(resolveMenuEntries(false, false, 'source')).toEqual(['paste'])
  })

  it('只读跟随侧（分屏）：有选区仅复制', () => {
    expect(resolveMenuEntries(true, false, 'source', false)).toEqual(['copy'])
  })

  it('只读跟随侧且无选区：无条目（调用方不弹菜单）', () => {
    expect(resolveMenuEntries(false, false, 'source', false)).toEqual([])
  })
})
