import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { findMatches, findTextRanges, compileQuery, expandReplacement } from '../find'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    /** 行内原子节点：验证匹配不跨越它 */
    hard_break: { inline: true, group: 'inline', selectable: false },
  },
  marks: {
    strong: {},
  },
})

const doc = (texts: string[]) =>
  schema.node(
    'doc',
    null,
    texts.map((t) => schema.node('paragraph', null, schema.text(t))),
  )

/** 构造单段落文档，内容为任意行内节点序列（跨节点 / 原子节点用例） */
const docWith = (children: ReturnType<typeof schema.text>[]) =>
  schema.node('doc', null, schema.node('paragraph', null, children))

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

describe('findMatches 跨节点匹配', () => {
  it('格式标记不阻断匹配（**bo**ld 可搜到 bold）', () => {
    const strong = schema.marks.strong.create()
    const d = docWith([schema.text('bo', [strong]), schema.text('ld')])
    expect(findMatches(d, 'bold')).toEqual([{ from: 1, to: 5 }])
  })

  it('不跨段落', () => {
    expect(findMatches(doc(['ab', 'cd']), 'bc')).toEqual([])
  })

  it('不跨越行内原子节点（硬换行两侧互不连通）', () => {
    const d = docWith([schema.text('abc'), schema.node('hard_break'), schema.text('def')])
    expect(findMatches(d, 'cde')).toEqual([])
    expect(findMatches(d, 'abc')).toEqual([{ from: 1, to: 4 }])
    expect(findMatches(d, 'def')).toEqual([{ from: 5, to: 8 }])
  })
})

describe('findMatches 正则模式', () => {
  it('按正则匹配（大小写不敏感）并带回命中原文', () => {
    expect(findMatches(doc(['Foo bar']), 'f.o', { regex: true })).toEqual([
      { from: 1, to: 4, raw: 'Foo', groups: [] },
    ])
  })

  it('捕获组随匹配返回（供替换串展开）', () => {
    const matches = findMatches(doc(['a@b']), '(\\w+)@(\\w+)', { regex: true })
    expect(matches[0].groups).toEqual(['a', 'b'])
    expect(matches[0].raw).toBe('a@b')
  })

  it('非法表达式返回空数组且不抛错', () => {
    expect(findMatches(doc(['x']), '([', { regex: true })).toEqual([])
    expect(compileQuery('([')).toBeNull()
    expect(compileQuery('ok')).not.toBeNull()
  })

  it('可产生空匹配的表达式不会死循环', () => {
    expect(findMatches(doc(['bbb']), 'a*', { regex: true })).toEqual([])
  })

  it('匹配数受上限保护', () => {
    expect(findMatches(doc(['a'.repeat(2100)]), 'a').length).toBe(2000)
  })
})

describe('expandReplacement 替换串展开', () => {
  const match = { from: 0, to: 3, raw: 'a@b', groups: ['a', 'b'] }

  it('$1 / $2 取捕获组，$& 取命中原文', () => {
    expect(expandReplacement(match, '$2·$1')).toBe('b·a')
    expect(expandReplacement(match, '[$&]')).toBe('[a@b]')
  })

  it('$$ 为字面 $，$0 保持字面', () => {
    expect(expandReplacement(match, '$$1')).toBe('$1')
    expect(expandReplacement(match, '$0')).toBe('$0')
  })

  it('引用不存在的捕获组得空串', () => {
    expect(expandReplacement(match, '$3')).toBe('')
  })

  it('普通模式（无捕获组）按字面处理', () => {
    expect(expandReplacement({ from: 0, to: 1 }, '$1')).toBe('$1')
  })
})

// ---------------------------------------------------------------------------
// 查找状态随文档编辑的映射与校验（回归：匹配列表曾只在查询变化时重算，
// 编辑后旧坐标导致高亮错位、findStep 越界、替换写错位置）
// ---------------------------------------------------------------------------
import { EditorState } from '@milkdown/kit/prose/state'
import {
  computeFindState,
  mapMatchesThroughTrs,
  rangeMatchesQuery,
} from '../find'

describe('computeFindState', () => {
  it('返回匹配列表并把序号钳制到有效范围', () => {
    const d = doc(['aXbXc'])
    const s = computeFindState(d, 'x', {}, 99)
    expect(s.matches).toHaveLength(2)
    expect(s.index).toBe(1)
    expect(computeFindState(d, 'x', {}, -5).index).toBe(0)
    expect(computeFindState(d, 'zzz', {}, 0).index).toBe(-1)
  })
})

describe('mapMatchesThroughTrs', () => {
  const st = EditorState.create({ doc: doc(['hello world']) })

  it('匹配前的插入整体后移区间', () => {
    const tr = st.tr.insertText('XY', 1)
    const mapped = mapMatchesThroughTrs([{ from: 7, to: 12 }], [tr])
    expect(mapped[0].from).toBe(9)
    expect(mapped[0].to).toBe(14)
  })

  it('匹配内的插入扩展区间（打字落在命中内）', () => {
    // 'world' = [7,12)；在 9 处（wo|rld 之间）插入
    const tr = st.tr.insertText('ZZ', 9)
    const mapped = mapMatchesThroughTrs([{ from: 7, to: 12 }], [tr])
    expect(mapped[0].from).toBe(7)
    expect(mapped[0].to).toBe(14)
  })

  it('删除使区间收缩且不出界', () => {
    const tr = st.tr.delete(1, 7) // 删掉 'hello '
    const mapped = mapMatchesThroughTrs([{ from: 7, to: 12 }], [tr])
    expect(mapped[0]).toEqual({ from: 1, to: 6 })
  })

  it('多事务按顺序复合映射，docChanged 为假的事务被跳过', () => {
    const trInsert = st.tr.insertText('Q', 1)
    const meta = st.tr.setMeta('find-update', true)
    const trDelete = st.tr.delete(1, 3)
    const mapped = mapMatchesThroughTrs([{ from: 7, to: 12 }], [trInsert, meta, trDelete])
    // 插入 +1 后删除 -2 → 净 -1
    expect(mapped[0].from).toBe(6)
    expect(mapped[0].to).toBe(11)
  })
})

describe('rangeMatchesQuery', () => {
  it('区间文本仍对应查询词时通过（大小写不敏感）', () => {
    const d = doc(['hello world'])
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'hello', {})).toBe(true)
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'HELLO', {})).toBe(true)
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'world', {})).toBe(false)
  })

  it('正则模式要求区间整体命中', () => {
    const d = doc(['hello world'])
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'h(e)llo', { regex: true })).toBe(true)
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'h(e)lloX', { regex: true })).toBe(false)
    expect(rangeMatchesQuery(d, { from: 1, to: 6 }, 'e', { regex: true })).toBe(false)
  })

  it('越界或倒置区间直接失配', () => {
    const d = doc(['hello world'])
    expect(rangeMatchesQuery(d, { from: 1, to: 999 }, 'hello', {})).toBe(false)
    expect(rangeMatchesQuery(d, { from: 6, to: 6 }, 'hello', {})).toBe(false)
  })
})
