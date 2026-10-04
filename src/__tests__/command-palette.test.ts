import { describe, it, expect } from 'vitest'
import { rankCommands, type CommandItem } from '../command-palette'

/** 构造命令条目（title 缺省用 id） */
const cmd = (id: string, title = id, keywords?: string): CommandItem => ({
  id,
  title,
  keywords,
  run: () => {},
})

describe('rankCommands', () => {
  const items = [
    cmd('save', '保存', 'save write'),
    cmd('export-pdf', '导出 PDF', 'export pdf print'),
    cmd('fmt-bold', '加粗', 'bold strong'),
    cmd('view-source', '源码模式', 'source mode codemirror'),
  ]

  it('空查询按原序返回全部', () => {
    expect(rankCommands('', items)).toEqual(items)
  })

  it('标题子序列命中并按得分排序', () => {
    const ranked = rankCommands('导出', items)
    expect(ranked.map((c) => c.id)).toEqual(['export-pdf'])
  })

  it('关键词命中可检索中文命令（权重低于标题命中）', () => {
    // "source" 只命中 view-source 的关键词
    expect(rankCommands('source', items).map((c) => c.id)).toEqual(['view-source'])
    // "save" 同时命中保存的标题与关键词——标题命中在前
    expect(rankCommands('save', items)[0].id).toBe('save')
  })

  it('无命中返回空列表', () => {
    expect(rankCommands('zzzz', items)).toEqual([])
  })

  it('同分时标题短者在前', () => {
    const ranked = rankCommands('ab', [cmd('long', 'xxabxxxxxxxx'), cmd('short', 'xxab')])
    expect(ranked[0].id).toBe('short')
  })
})
