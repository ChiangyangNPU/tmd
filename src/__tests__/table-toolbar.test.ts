import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import type { Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { Transaction } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import { history, undo } from '@milkdown/kit/prose/history'
import {
  findTableContext,
  isAnchorVisible,
  computeToolbarPlacement,
  runTableAction,
} from '../table-toolbar'
import { tableFromPipeRow } from '../table-input'
import type { EditorView } from '@milkdown/kit/prose/view'

// 与 Milkdown gfm 同名、带 tableRole 的最小表格 schema（prosemirror-tables 依赖 role）
// 单元格内容与真实 gfm 一致为 'paragraph'（tableNodes({ cellContent: 'paragraph' })）
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    table: {
      content: 'table_header_row table_row+',
      tableRole: 'table',
      group: 'block',
    },
    table_header_row: { content: 'table_header*', tableRole: 'row' },
    table_row: { content: 'table_cell*', tableRole: 'row' },
    table_header: {
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

/** 构造 rows×cols 表格：首行为表头，单元格文本 r{row}c{col} */
const makeTable = (rows: number, cols: number): Node =>
  schema.node('table', null, [
    schema.node(
      'table_header_row',
      null,
      Array.from({ length: cols }, (_, c) =>
        schema.node('table_header', null, [schema.node('paragraph', null, [schema.text(`h${c}`)])]),
      ),
    ),
    ...Array.from({ length: rows - 1 }, (_, r) =>
      schema.node(
        'table_row',
        null,
        Array.from({ length: cols }, (_, c) =>
          schema.node('table_cell', null, [
            schema.node('paragraph', null, [schema.text(`r${r + 1}c${c}`)]),
          ]),
        ),
      ),
    ),
  ])

/** 把光标放进指定行列的单元格里（表格包进 doc，位于文档开头） */
const stateIn = (table: Node, row: number, col: number): EditorState => {
  const doc = schema.node('doc', null, [table])
  const map = TableMap.get(table)
  const cellRel = map.positionAt(row, col, table)
  const $pos = doc.resolve(cellRel + 1)
  return EditorState.create({ doc, selection: TextSelection.near($pos) })
}

const stubView = (state: EditorState): EditorView =>
  ({
    state,
    dispatch: () => {},
    focus: () => {},
  }) as unknown as EditorView

/** 带真实 dispatch 的视图桩：把事务应用到 state 并交给 onChange */
const viewWith = (state: EditorState, onChange: (next: EditorState) => void): EditorView =>
  ({
    state,
    dispatch: (tr: Transaction) => onChange(state.apply(tr)),
    focus: () => {},
  }) as unknown as EditorView

/** 执行命令并把其事务应用到当前 state，返回新 state（命令返回 false 则原样返回） */
const applyCommand = (
  state: EditorState,
  run: (s: EditorState, view: EditorView) => boolean,
): EditorState => {
  let result = state
  run(
    state,
    viewWith(state, (next) => {
      result = next
    }),
  )
  return result
}

describe('findTableContext', () => {
  it('解析光标所在表格与行列下标', () => {
    const table = makeTable(3, 3)
    const ctx = findTableContext(stateIn(table, 2, 1))
    expect(ctx).not.toBeNull()
    expect(ctx?.row).toBe(2)
    expect(ctx?.col).toBe(1)
    expect(ctx?.map.width).toBe(3)
    expect(ctx?.map.height).toBe(3)
  })

  it('光标不在表格内返回 null', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('plain')])])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
    })
    expect(findTableContext(state)).toBeNull()
  })
})

describe('悬浮工具栏显隐与定位', () => {
  /** 表格 DOM 的视口矩形 */
  const anchor = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
  })

  it('源码模式下表格 DOM 无布局尺寸（宽高全 0）→ 不显示', () => {
    // 所见即所得区被 hidden 时其内元素矩形全为 0，工具栏若照常定位会
    // 落到左上角兜底位置压住顶部工具栏按钮
    expect(isAnchorVisible(anchor(0, 0, 0, 0))).toBe(false)
  })

  it('表格有布局尺寸即可见（宽或高任一大于 0）', () => {
    expect(isAnchorVisible(anchor(100, 200, 200, 50))).toBe(true)
    expect(isAnchorVisible(anchor(0, 0, 1, 0))).toBe(true)
    expect(isAnchorVisible(anchor(0, 0, 0, 1))).toBe(true)
  })

  it('落位：表格上方居中，与表格上边缘留 6px 间距', () => {
    // 表格水平中心 200，工具栏宽 100 → left = 200 - 50 = 150
    expect(computeToolbarPlacement(anchor(100, 200, 200, 50), 100, 30, 800)).toEqual({
      left: 150,
      top: 164, // 200 - 30 - 6
    })
  })

  it('落位：左越界夹到视口留白、右越界夹到视口内', () => {
    // 表格贴左边缘 → 居中后为负，夹到 8
    expect(computeToolbarPlacement(anchor(0, 100, 40, 20), 200, 30, 800).left).toBe(8)
    // 表格贴右边缘 → 夹到 800 - 200 - 8 = 592
    expect(computeToolbarPlacement(anchor(700, 100, 100, 20), 200, 30, 800).left).toBe(592)
  })

  it('落位：表格贴近视口顶部时工具栏下移，不越出上边界', () => {
    expect(computeToolbarPlacement(anchor(100, 10, 200, 50), 100, 30, 800).top).toBe(8)
  })
})

describe('表格动作', () => {
  it('光标在表格外时动作返回 false', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('plain')])])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) })
    expect(runTableAction(stubView(state), 'row-after')).toBe(false)
    expect(runTableAction(stubView(state), 'align-center')).toBe(false)
  })

  it('row-after 在表格内可执行', () => {
    const table = makeTable(2, 2)
    const state = stateIn(table, 0, 0)
    const result: { doc: Node | null } = { doc: null }
    const view = {
      state,
      focus: () => {},
      dispatch: (tr: { doc: Node }) => {
        result.doc = tr.doc
      },
    } as unknown as EditorView
    expect(runTableAction(view, 'row-after')).toBe(true)
    expect(result.doc?.firstChild?.childCount).toBe(3) // 2 行 → 3 行
  })

  it('col-delete 删除当前列（列数减一）', () => {
    const table = makeTable(2, 3)
    const state = stateIn(table, 1, 1)
    const result: { doc: Node | null } = { doc: null }
    const view = {
      state,
      focus: () => {},
      dispatch: (tr: { doc: Node }) => {
        result.doc = tr.doc
      },
    } as unknown as EditorView
    expect(runTableAction(view, 'col-delete')).toBe(true)
    expect(result.doc?.firstChild?.firstChild?.childCount).toBe(2) // 3 列 → 2 列
  })

  it('align-center 更新当前列表头单元格的 alignment', () => {
    const table = makeTable(2, 2)
    const state = stateIn(table, 0, 1) // 光标在表头第 2 列
    const result: { doc: Node | null } = { doc: null }
    const view = {
      state,
      focus: () => {},
      dispatch: (tr: { doc: Node }) => {
        result.doc = tr.doc
      },
    } as unknown as EditorView
    expect(runTableAction(view, 'align-center')).toBe(true)
    const headerCell = result.doc?.firstChild?.firstChild?.child(1)
    expect(headerCell?.attrs.alignment).toBe('center')
  })

  it('整列 CellSelection 构造覆盖该列首尾单元格', () => {
    const table = makeTable(3, 3)
    const state = stateIn(table, 1, 1)
    const ctx = findTableContext(state)!
    const positions = ctx.map
      .cellsInRect({ left: 1, right: 2, top: 0, bottom: 3 })
      .map((rel) => ctx.tablePos + 1 + rel)
    expect(positions).toHaveLength(3)
    const sel = CellSelection.create(state.doc, positions[0], positions[2])
    expect(sel.$anchorCell.pos).toBe(positions[0])
    expect(sel.$headCell.pos).toBe(positions[2])
  })

  it('table-delete 整体移除表格', () => {
    const table = makeTable(2, 3)
    const state = stateIn(table, 1, 1)
    const result: { doc: Node | null } = { doc: null }
    const view = {
      state,
      focus: () => {},
      dispatch: (tr: { doc: Node }) => {
        result.doc = tr.doc
      },
    } as unknown as EditorView
    expect(runTableAction(view, 'table-delete')).toBe(true)
    expect(result.doc?.childCount).toBe(1) // 表格删除后补一个空段落
    expect(result.doc?.firstChild?.type.name).toBe('paragraph')
    expect(result.doc?.firstChild?.textContent).toBe('')
  })

  it('table-delete 光标落到表格后的段落', () => {
    const table = makeTable(2, 2)
    const doc = schema.node('doc', null, [
      table,
      schema.node('paragraph', null, [schema.text('后面的段落')]),
    ])
    const map = TableMap.get(table)
    const $pos = doc.resolve(map.positionAt(0, 0, table) + 1)
    const state = EditorState.create({ doc, selection: TextSelection.near($pos) })
    const result: { doc: Node | null; from: number | null } = { doc: null, from: null }
    const view = {
      state,
      focus: () => {},
      dispatch: (tr: { doc: Node; selection: { from: number } }) => {
        result.doc = tr.doc
        result.from = tr.selection.from
      },
    } as unknown as EditorView
    expect(runTableAction(view, 'table-delete')).toBe(true)
    expect(result.doc?.childCount).toBe(1)
    // 表格被删除，剩余段落开头（位置 1）
    expect(result.from).toBe(1)
    expect(result.doc?.firstChild?.textContent).toBe('后面的段落')
  })

  it('光标在表格外 table-delete 返回 false', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('plain')])])
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) })
    expect(runTableAction(stubView(state), 'table-delete')).toBe(false)
  })

  it('table-delete 可单独撤销（一次 undo 恢复表格）', () => {
    // 复现真实编辑序列：输入管道文本 → 回车建表 → 点删除整表 → 撤销
    const text = '| a | b |'
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1 + text.length),
      plugins: [history()],
    })

    // 1) 建表（table-input 的 closeHistory 已将其断为独立撤销组）
    state = applyCommand(state, (s, v) => tableFromPipeRow(s, v.dispatch))
    expect(state.doc.firstChild?.type.name).toBe('table')

    // 2) 光标在表格内删除整表
    state = applyCommand(state, (_s, v) => runTableAction(v, 'table-delete'))
    expect(state.doc.firstChild?.type.name).toBe('paragraph')

    // 3) 一次撤销应回到「表格」。若删除事务未 closeHistory，会与建表事务
    //    并成一组，撤销直接退回建表前的管道文本
    state = applyCommand(state, (s, v) => undo(s, v.dispatch))
    expect(state.doc.firstChild?.type.name).toBe('table')
  })
})
