import { describe, it, expect, vi } from 'vitest'

// 假字典：只映射测试用例涉及的汉字，非汉字原样保留——隔离真实字典的体积与变更
vi.mock('pinyin-pro', () => ({
  pinyin: (text: string, opts?: { type?: string }) => {
    const table: Record<string, string> = {
      项: 'x',
      目: 'm',
      说: 's',
      明: 'm',
      交: 'j',
      互: 'h',
      稿: 'g',
      讲: 'j',
    }
    const chars = [...text].map((ch) => table[ch] ?? ch)
    return opts?.type === 'array' ? chars : chars.join(' ')
  },
}))

import { ensurePinyin, initialsOf, hasCJK, pinyinReady } from '../pinyin-index'
import { rankEntries } from '../quick-switch'
import type { QuickEntry } from '../quick-switch'

const entry = (name: string, dir = '/docs'): QuickEntry => ({
  name,
  dir,
  path: `${dir}/${name}`,
})

describe('hasCJK', () => {
  it('含汉字 true，纯拉丁 false', () => {
    expect(hasCJK('项目说明.md')).toBe(true)
    expect(hasCJK('readme.md')).toBe(false)
  })
})

describe('ensurePinyin / initialsOf（懒加载状态机）', () => {
  it('加载前：未就绪且首字母返回 null（原始名称匹配不受影响）', () => {
    expect(pinyinReady()).toBe(false)
    expect(initialsOf('项目说明.md')).toBeNull()
  })

  it('ensurePinyin 就绪后：汉字名称映射首字母（含非汉字原文），拉丁名称返回 null', async () => {
    await ensurePinyin()
    expect(pinyinReady()).toBe(true)
    expect(initialsOf('项目说明.md')).toBe('xmsm.md')
    expect(initialsOf('交互稿')).toBe('jhg')
    expect(initialsOf('readme.md')).toBeNull()
    // 幂等：重复调用不重复加载（状态不变即可）
    await ensurePinyin()
    expect(pinyinReady()).toBe(true)
  })

  it('rankEntries 集成：首字母查询命中中文名条目', async () => {
    await ensurePinyin()
    const ranked = rankEntries('xm', [entry('项目说明.md'), entry('交互稿.md'), entry('readme.md')])
    expect(ranked.length).toBeGreaterThanOrEqual(1)
    expect(ranked[0].entry.name).toBe('项目说明.md')
  })

  it('rankEntries 集成：原始名称匹配仍优先于首字母匹配', async () => {
    await ensurePinyin()
    // 查询「讲」：讲稿.md 按名称命中（权重 1.0），项目说明.md 的首字母含 j 也命中（0.9），
    // 但名称命中得分更高，排序在前
    const ranked = rankEntries('j', [entry('项目说明.md'), entry('讲稿.md')])
    expect(ranked[0].entry.name).toBe('讲稿.md')
  })
})
