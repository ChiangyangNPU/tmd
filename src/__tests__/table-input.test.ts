import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { splitPipeRow, parseDelimiterRow, parseHeaderRow, tableFromDelimiter } from '../table-input'

// ---------------------------------------------------------------------------
// 纯函数：管道行解析
// ---------------------------------------------------------------------------

describe('splitPipeRow', () => {
  it('按管道符分列并去除首尾管道与空白', () => {
    expect(splitPipeRow('| a | b |')).toEqual(['a', 'b'])
    expect(splitPipeRow('a | b')).toEqual(['a', 'b'])
    expect(splitPipeRow('|a|b|c|')).toEqual(['a', 'b', 'c'])
  })

  it('单元格两侧空白 trim，空单元格保留为空串', () => {
    expect(splitPipeRow('|  a   |   | b|')).toEqual(['a', '', 'b'])
  })

  it('转义管道符 \\| 还原为字面 |，不作为分列点', () => {
    expect(splitPipeRow('a \\| b | c')).toEqual(['a | b', 'c'])
    expect(splitPipeRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('没有管道时整体作为一个单元格', () => {
    expect(splitPipeRow('  hello  ')).toEqual(['hello'])
  })
})

describe('parseDelimiterRow', () => {
  it('标准短横分隔行返回 null 对齐', () => {
    expect(parseDelimiterRow('| -- | -- |')).toEqual([null, null])
    expect(parseDelimiterRow('| - | --- |')).toEqual([null, null])
  })

  it('首尾管道可省略', () => {
    expect(parseDelimiterRow(':-- | :-: | --:')).toEqual(['left', 'center', 'right'])
  })

  it('识别冒号对齐 left/center/right', () => {
    expect(parseDelimiterRow('| :-- | :-: | --: |')).toEqual(['left', 'center', 'right'])
    expect(parseDelimiterRow('| :-- |')).toEqual(['left'])
    expect(parseDelimiterRow('|:---:|')).toEqual(['center'])
  })

  it('无管道的 --- / - 不视为分隔行（避免水平线、列表误判）', () => {
    expect(parseDelimiterRow('---')).toBeNull()
    expect(parseDelimiterRow('-')).toBeNull()
    expect(parseDelimiterRow(' :-- ')).toBeNull()
  })

  it('非法单元格返回 null', () => {
    expect(parseDelimiterRow('| -- | x |')).toBeNull()
    expect(parseDelimiterRow('| : |')).toBeNull()
    expect(parseDelimiterRow('|')).toBeNull()
    expect(parseDelimiterRow('')).toBeNull()
  })
})

describe('parseHeaderRow', () => {
  it('列数一致返回单元格文本', () => {
    expect(parseHeaderRow('| 姓名 | 年龄 |', 2)).toEqual(['姓名', '年龄'])
    expect(parseHeaderRow('a | b', 2)).toEqual(['a', 'b'])
  })

  it('允许空表头格', () => {
    expect(parseHeaderRow('|  | b |', 2)).toEqual(['', 'b'])
  })

  it('列数不一致返回 null', () => {
    expect(parseHeaderRow('| a | b | c |', 2)).toBeNull()
    expect(parseHeaderRow('| a |', 2)).toBeNull()
  })

  it('含物理换行（硬换行段落）返回 null', () => {
    expect(parseHeaderRow('a | b\nc | d', 2)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Enter 行为：两段转表格（最小 gfm 同构 schema，参照 table-toolbar.test.ts）
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    blockquote: { content: 'block+', group: 'block' },
    table: {
      content: 'table_header_row table_row+',
      tableRole: 'table',
      group: 'block',
    },
    table_header_row: { content: 'table_header*', tableRole: 'row' },
    table_row: { content: 'table_cell*', tableRole: 'row' },
    table_header: {
      // 与真实 gfm schema 一致为 paragraph+：createAndFill 才会自动补空段落
      content: 'paragraph+',
      tableRole: 'header_cell',
      attrs: {
        alignment: { default: null },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    table_cell: {
      content: 'paragraph+',
      tableRole: 'cell',
      attrs: {
        alignment: { default: null },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
  },
})

const p = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])

/** 段末光标状态：paraIndex 指 doc 第几个顶层段落（0 起） */
function stateAtParaEnd(nodes: ReturnType<typeof p>[], paraIndex: number) {
  const doc = schema.node('doc', null, nodes)
  let pos = 1
  for (let i = 0; i < paraIndex; i++) pos += nodes[i].nodeSize
  pos += nodes[paraIndex].content.size
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

const run = (state: EditorState) => {
  let dispatched = false
  const result = tableFromDelimiter(state, (tr) => {
    dispatched = true
    state = state.apply(tr)
  })
  return { result, dispatched, state }
}

describe('tableFromDelimiter', () => {
  it('表头段+分隔行段末回车：两段替换为表格，表头文本入格', () => {
    const before = stateAtParaEnd([p('| a | b |'), p('| -- | -- |')], 1)
    const { result, dispatched, state } = run(before)
    expect(result).toBe(true)
    expect(dispatched).toBe(true)

    const table = state.doc.firstChild!
    expect(table.type.name).toBe('table')
    expect(table.childCount).toBe(2)

    const headerRow = table.child(0)
    expect(headerRow.type.name).toBe('table_header_row')
    expect(headerRow.childCount).toBe(2)
    expect(headerRow.child(0).textContent).toBe('a')
    expect(headerRow.child(1).textContent).toBe('b')

    const dataRow = table.child(1)
    expect(dataRow.type.name).toBe('table_row')
    expect(dataRow.childCount).toBe(2)
    expect(dataRow.child(0).textContent).toBe('')
    expect(dataRow.child(1).textContent).toBe('')
  })

  it('分隔行冒号对齐写入单元格 alignment', () => {
    const { state } = run(stateAtParaEnd([p('a | b | c'), p(':-- | :-: | --:')], 1))
    const headerCells = state.doc.firstChild!.child(0)
    const dataCells = state.doc.firstChild!.child(1)
    expect(headerCells.child(0).attrs.alignment).toBe('left')
    expect(headerCells.child(1).attrs.alignment).toBe('center')
    expect(dataCells.child(2).attrs.alignment).toBe('right')
  })

  it('转换后选区落在第一行数据单元格内', () => {
    const { state } = run(stateAtParaEnd([p('| a | b |'), p('| -- | -- |')], 1))
    const { $from } = state.selection
    expect($from.node($from.depth - 1).type.name).toBe('table_cell')
  })

  it('空表头格可正常成表', () => {
    const { result, state } = run(stateAtParaEnd([p('|  | b |'), p('| -- | -- |')], 1))
    expect(result).toBe(true)
    expect(state.doc.firstChild!.child(0).child(0).textContent).toBe('')
  })

  it('分隔行位于文档首行（无表头）不触发', () => {
    const before = stateAtParaEnd([p('| -- | -- |')], 0)
    const { result, dispatched } = run(before)
    expect(result).toBe(false)
    expect(dispatched).toBe(false)
  })

  it('表头与分隔行列数不一致不触发', () => {
    const before = stateAtParaEnd([p('| a | b | c |'), p('| -- | -- |')], 1)
    const { result, state } = run(before)
    expect(result).toBe(false)
    expect(state.doc).toBe(before.doc)
  })

  it('当前段落不是分隔行不触发（普通回车分段）', () => {
    const before = stateAtParaEnd([p('| a | b |'), p('普通段落')], 1)
    const { result } = run(before)
    expect(result).toBe(false)
  })

  it('光标不在段尾不触发', () => {
    const doc = schema.node('doc', null, [p('| a | b |'), p('| -- | -- |')])
    // 第二段段首
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, p('| a | b |').nodeSize + 1),
    })
    expect(tableFromDelimiter(state)).toBe(false)
  })

  it('引用块内（depth≠1）不触发', () => {
    const quote = schema.node('blockquote', null, [p('| a | b |'), p('| -- | -- |')])
    const doc = schema.node('doc', null, [quote])
    const innerStart = 2 // doc>quote>paragraph
    const delimPos = innerStart + p('| a | b |').nodeSize + p('| -- | -- |').content.size
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, delimPos),
    })
    expect(tableFromDelimiter(state)).toBe(false)
  })

  it('无 dispatch 时仅查询：返回 true 且文档不变', () => {
    const before = stateAtParaEnd([p('| a | b |'), p('| -- | -- |')], 1)
    expect(tableFromDelimiter(before)).toBe(true)
  })
})
