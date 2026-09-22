import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { findMatches, findTextRanges } from '../find'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
  },
})

const doc = (texts: string[]) =>
  schema.node(
    'doc',
    null,
    texts.map((t) => schema.node('paragraph', null, schema.text(t))),
  )

describe('findMatches', () => {
  it('空查询返回空', () => {
    expect(findMatches(doc(['hello']), '')).toEqual([])
  })

  it('大小写不敏感，位置正确', () => {
    const d = doc(['Hello hello'])
    expect(findMatches(d, 'hello')).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
    ])
  })

  it('跨段落分别定位', () => {
    const d = doc(['abc', 'ab'])
    expect(findMatches(d, 'ab')).toEqual([
      { from: 1, to: 3 },
      { from: 6, to: 8 },
    ])
  })

  it('同段重叠匹配不遗漏', () => {
    const d = doc(['aaa'])
    expect(findMatches(d, 'aa')).toEqual([{ from: 1, to: 3 }])
  })

  it('小写化改变字符长度时退回大小写敏感匹配，节点内位置不偏移', () => {
    // 'İ'.toLowerCase() 长度为 2，直接用小写串下标会算出错误区间
    expect(findMatches(doc(['İx']), 'İx')).toEqual([{ from: 1, to: 3 }])
  })
})

describe('findTextRanges', () => {
  it('空查询返回空', () => {
    expect(findTextRanges('hello', '')).toEqual([])
  })

  it('大小写不敏感，返回文本下标', () => {
    expect(findTextRanges('Hello hello', 'hello')).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
    ])
  })

  it('跨行匹配（源码模式文档含换行）', () => {
    expect(findTextRanges('a\nb\nab', 'ab')).toEqual([{ from: 4, to: 6 }])
  })

  it('未命中返回空数组', () => {
    expect(findTextRanges('abc', 'zzz')).toEqual([])
  })

  it('小写化改变字符长度时退回大小写敏感匹配，下标不偏移', () => {
    expect(findTextRanges('İx', 'İx')).toEqual([{ from: 0, to: 2 }])
  })
})
