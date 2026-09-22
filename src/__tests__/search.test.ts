import { describe, it, expect } from 'vitest'
import { splitHighlights, groupMatches } from '../search'
import type { SearchMatch } from '../native'

describe('splitHighlights', () => {
  it('按关键词切分并标记命中段', () => {
    expect(splitHighlights('hello world', 'world')).toEqual([
      { text: 'hello ', hit: false },
      { text: 'world', hit: true },
    ])
  })

  it('大小写不敏感，保留原文大小写', () => {
    expect(splitHighlights('Hello World', 'WORLD')).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ])
  })

  it('同一行多次命中全部标出', () => {
    const segments = splitHighlights('aXbXc', 'x')
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['X', 'X'])
  })

  it('关键词为空时整行作为单个非命中片段', () => {
    expect(splitHighlights('abc', '')).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlights('', '')).toEqual([])
  })

  it('未命中时返回单个非命中片段', () => {
    expect(splitHighlights('abc', 'zzz')).toEqual([{ text: 'abc', hit: false }])
  })

  it('命中位于行首或整行时不产生空片段', () => {
    expect(splitHighlights('abc', 'abc')).toEqual([{ text: 'abc', hit: true }])
    expect(splitHighlights('xabc', 'abc')).toEqual([
      { text: 'x', hit: false },
      { text: 'abc', hit: true },
    ])
  })
})

describe('groupMatches', () => {
  /** 构造一条命中（只关心分组关注的字段） */
  const match = (path: string, line: number): SearchMatch => ({
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    line,
    column: 1,
    occurrence: 1,
    text: 'x',
  })

  it('按文件路径分组，保持首次出现顺序与文件内行序', () => {
    const groups = groupMatches([
      match('/a/one.md', 1),
      match('/b/two.md', 2),
      match('/a/one.md', 5),
    ])
    expect(groups.map((g) => g.path)).toEqual(['/a/one.md', '/b/two.md'])
    expect(groups[0].matches.map((m) => m.line)).toEqual([1, 5])
    expect(groups[1].matches.map((m) => m.line)).toEqual([2])
  })

  it('目录规范化为正斜杠（Windows 路径）', () => {
    const groups = groupMatches([match('E:\\docs\\a.md', 1)])
    expect(groups[0].dir).toBe('E:/docs')
    expect(groups[0].name).toBe('a.md')
  })

  it('空输入返回空数组', () => {
    expect(groupMatches([])).toEqual([])
  })
})
