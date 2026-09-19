import { describe, it, expect } from 'vitest'
import { tabMenuEnabled, closeTargets } from '../tab-menu'

/** closeTargets 的输入样例：5 个标签，第 2、4 个（0 基）是脏的 */
const TABS = [
  { id: 't1', dirty: false },
  { id: 't2', dirty: true },
  { id: 't3', dirty: false },
  { id: 't4', dirty: true },
  { id: 't5', dirty: false },
]

describe('tabMenuEnabled', () => {
  it('中间位置：全部可用', () => {
    expect(tabMenuEnabled(2, 5, 3)).toEqual({
      close: true,
      closeOthers: true,
      closeLeft: true,
      closeRight: true,
      closeSaved: true,
      closeAll: true,
    })
  })

  it('第一个标签：关闭左侧不可用', () => {
    const enabled = tabMenuEnabled(0, 5, 3)
    expect(enabled.closeLeft).toBe(false)
    expect(enabled.closeRight).toBe(true)
  })

  it('最后一个标签：关闭右侧不可用', () => {
    const enabled = tabMenuEnabled(4, 5, 3)
    expect(enabled.closeLeft).toBe(true)
    expect(enabled.closeRight).toBe(false)
  })

  it('只有一个标签：关闭其他不可用；锚点已被关闭时关闭也不可用', () => {
    const enabled = tabMenuEnabled(0, 1, 1)
    expect(enabled.closeOthers).toBe(false)
    expect(enabled.closeLeft).toBe(false)
    expect(enabled.closeRight).toBe(false)
    expect(tabMenuEnabled(-1, 0, 0).close).toBe(false)
  })

  it('全部脏标签：关闭已保存不可用', () => {
    expect(tabMenuEnabled(0, 2, 0).closeSaved).toBe(false)
    expect(tabMenuEnabled(0, 2, 1).closeSaved).toBe(true)
  })
})

describe('closeTargets', () => {
  it('关闭：仅锚点自身', () => {
    expect(closeTargets('close', 't3', TABS)).toEqual(['t3'])
  })

  it('关闭其他：除锚点外全部（保持顺序）', () => {
    expect(closeTargets('closeOthers', 't3', TABS)).toEqual(['t1', 't2', 't4', 't5'])
  })

  it('关闭左侧 / 右侧：锚点两侧的分界正确', () => {
    expect(closeTargets('closeLeft', 't3', TABS)).toEqual(['t1', 't2'])
    expect(closeTargets('closeRight', 't3', TABS)).toEqual(['t4', 't5'])
  })

  it('关闭已保存：只含干净标签（可能包含锚点）', () => {
    expect(closeTargets('closeSaved', 't4', TABS)).toEqual(['t1', 't3', 't5'])
    expect(closeTargets('closeSaved', 't1', TABS)).toEqual(['t1', 't3', 't5'])
  })

  it('关闭所有：全部标签', () => {
    expect(closeTargets('closeAll', 't3', TABS)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('锚点不存在：返回空列表（调用方静默忽略）', () => {
    expect(closeTargets('close', 'gone', TABS)).toEqual([])
    expect(closeTargets('closeRight', 'gone', TABS)).toEqual([])
  })
})
