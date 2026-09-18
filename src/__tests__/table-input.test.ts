import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { TableMap } from '@milkdown/kit/prose/tables'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import {
  splitPipeRow,
  parseDelimiterRow,
  tableFromPipeRow,
  addRowOnModEnter,
} from '../table-input'

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

// ---------------------------------------------------------------------------
// Enter 行为：管道行回车即成表（最小 gfm 同构 schema，参照 table-toolbar.test.ts）
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
      // 与真实 gfm schema 一致：tableNodes({ cellContent: 'paragraph' })
      content: 'paragraph',
      tableRole: 'header_cell',
      attrs: {
        alignment: { default: null },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    table_cell: {
      content: 'paragraph',
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
  const result = tableFromPipeRow(state, (tr) => {
    dispatched = true
    state = state.apply(tr)
  })
  return { result, dispatched, state }
}

describe('tableFromPipeRow', () => {
  it('管道行段末回车：当前段落替换为表格，表头文本入格', () => {
    const before = stateAtParaEnd([p('| a | b |')], 0)
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

  it('对齐默认 null（成表后可用工具栏设置）', () => {
    const { state } = run(stateAtParaEnd([p('a | b | c')], 0))
    const headerCells = state.doc.firstChild!.child(0)
    const dataCells = state.doc.firstChild!.child(1)
    expect(headerCells.child(0).attrs.alignment).toBeNull()
    expect(headerCells.child(1).attrs.alignment).toBeNull()
    expect(dataCells.child(2).attrs.alignment).toBeNull()
  })

  it('转换后选区落在第一行数据单元格内', () => {
    const { state } = run(stateAtParaEnd([p('| a | b |')], 0))
    const { $from } = state.selection
    expect($from.node($from.depth - 1).type.name).toBe('table_cell')
  })

  it('省略首尾管道也可成表', () => {
    const { result, state } = run(stateAtParaEnd([p('左列 | 右列')], 0))
    expect(result).toBe(true)
    expect(state.doc.firstChild!.child(0).child(0).textContent).toBe('左列')
    expect(state.doc.firstChild!.child(0).child(1).textContent).toBe('右列')
  })

  it('空表头格可正常成表', () => {
    const { result, state } = run(stateAtParaEnd([p('|  | b |')], 0))
    expect(result).toBe(true)
    expect(state.doc.firstChild!.child(0).child(0).textContent).toBe('')
    expect(state.doc.firstChild!.child(0).child(1).textContent).toBe('b')
  })

  it('三列表头可成表', () => {
    const { result, state } = run(stateAtParaEnd([p('| a | b | c |')], 0))
    expect(result).toBe(true)
    expect(state.doc.firstChild!.child(0).childCount).toBe(3)
  })

  it('分隔行格式不触发（| -- | -- | 不作为表头）', () => {
    const before = stateAtParaEnd([p('| -- | -- |')], 0)
    const { result, dispatched } = run(before)
    expect(result).toBe(false)
    expect(dispatched).toBe(false)
  })

  it('无管道符不触发（普通文本回车分段）', () => {
    const before = stateAtParaEnd([p('普通文本')], 0)
    const { result } = run(before)
    expect(result).toBe(false)
  })

  it('水平线 --- 不触发', () => {
    const before = stateAtParaEnd([p('---')], 0)
    const { result } = run(before)
    expect(result).toBe(false)
  })

  it('光标不在段尾不触发', () => {
    const doc = schema.node('doc', null, [p('| a | b |')])
    // 段首位置
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) })
    expect(tableFromPipeRow(state)).toBe(false)
  })

  it('引用块内（depth≠1）不触发', () => {
    const quote = schema.node('blockquote', null, [p('| a | b |')])
    const doc = schema.node('doc', null, [quote])
    const innerStart = 2 // doc>quote>paragraph
    const paraEnd = innerStart + p('| a | b |').content.size
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, paraEnd) })
    expect(tableFromPipeRow(state)).toBe(false)
  })

  it('无 dispatch 时仅查询：返回 true 且文档不变', () => {
    const before = stateAtParaEnd([p('| a | b |')], 0)
    expect(tableFromPipeRow(before)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mod-Enter 行为：表格内当前行下方插入空行，表格外放行
// ---------------------------------------------------------------------------

/** 表头单元格 */
const hcell = (text: string) => schema.node('table_header', null, [p(text)])
/** 数据单元格（默认空） */
const dcell = (text = '') => schema.node('table_cell', null, [p(text)])

/** 构造两列表格：表头 a/b + 一行数据 1/2 */
function sampleTable(): ProseNode {
  return schema.node('table', null, [
    schema.node('table_header_row', null, [hcell('a'), hcell('b')]),
    schema.node('table_row', null, [dcell('1'), dcell('2')]),
  ])
}

/**
 * 光标落在表格第 row 行（0 为表头行）、第 col 列单元格的段落起始处。
 * 位置口径与 tableFromPipeRow 一致：tablePos+1 越过表格开 token，
 * rel 为单元格偏移，再 +2 越过单元格与段落开 token。
 */
function stateInCell(table: ProseNode, row: number, col: number): EditorState {
  const doc = schema.node('doc', null, [table])
  const rel = TableMap.get(table).positionAt(row, col, table)
  const inner = 1 + rel + 2
  return EditorState.create({ doc, selection: TextSelection.create(doc, inner) })
}

const runAddRow = (state: EditorState) => {
  let dispatched = false
  const result = addRowOnModEnter(state, (tr) => {
    dispatched = true
    state = state.apply(tr)
  })
  return { result, dispatched, state }
}

describe('addRowOnModEnter', () => {
  it('数据行内 Mod-Enter：当前行下方插入一空数据行', () => {
    const { result, dispatched, state } = runAddRow(stateInCell(sampleTable(), 1, 0))
    expect(result).toBe(true)
    expect(dispatched).toBe(true)

    const table = state.doc.firstChild!
    expect(table.childCount).toBe(3) // 表头行 + 原数据行 + 新数据行
    // 原行保留在原位，新行紧随其后且两格均为空
    expect(table.child(1).type.name).toBe('table_row')
    expect(table.child(1).child(0).textContent).toBe('1')
    expect(table.child(2).type.name).toBe('table_row')
    expect(table.child(2).child(0).textContent).toBe('')
    expect(table.child(2).child(1).textContent).toBe('')
  })

  it('表头行内 Mod-Enter 同样在下方插入数据行', () => {
    const { result, state } = runAddRow(stateInCell(sampleTable(), 0, 1))
    expect(result).toBe(true)
    const table = state.doc.firstChild!
    expect(table.childCount).toBe(3)
    expect(table.child(1).type.name).toBe('table_row')
    expect(table.child(1).child(0).textContent).toBe('')
  })

  it('表格外 Mod-Enter 放行：返回 false 且不分发事务', () => {
    const before = stateAtParaEnd([p('普通文本')], 0)
    const { result, dispatched } = runAddRow(before)
    expect(result).toBe(false)
    expect(dispatched).toBe(false)
  })

  it('无 dispatch 时仅查询：表格内返回 true 且文档不变', () => {
    const before = stateInCell(sampleTable(), 1, 0)
    expect(addRowOnModEnter(before)).toBe(true)
    expect(before.doc.firstChild!.childCount).toBe(2)
  })
})
