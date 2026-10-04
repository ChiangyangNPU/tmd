import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import type { Node as PmNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import {
  parseTsv,
  buildTableNode,
  createPasteTsvPlugin,
  TSV_MIN_ROWS,
  TSV_MIN_COLS,
} from '../paste-tsv'

// ---------------------------------------------------------------------------
// parseTsv：形状判定（纯函数）
// ---------------------------------------------------------------------------

describe('parseTsv', () => {
  it('标准 TSV（含末尾换行）解析为等宽二维数组', () => {
    expect(parseTsv('名称\t数量\n苹果\t3\n')).toEqual([
      ['名称', '数量'],
      ['苹果', '3'],
    ])
  })

  it('CRLF 换行容忍', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('空单元格保留为空串', () => {
    expect(parseTsv('a\tb\n\td')).toEqual([
      ['a', 'b'],
      ['', 'd'],
    ])
  })

  it('无制表符 → null', () => {
    expect(parseTsv('普通文本粘贴')).toBeNull()
    expect(parseTsv('')).toBeNull()
  })

  it('少于 2 行 → null（普通句子里的单个制表符不误触）', () => {
    expect(parseTsv('a\tb')).toBeNull()
    expect(parseTsv('a\tb\n')).toBeNull()
  })

  it('单列（无多列）→ null', () => {
    expect(parseTsv('a\nb\nc')).toBeNull()
  })

  it('列数不齐（中间含空行）→ null，按普通文本粘贴', () => {
    expect(parseTsv('a\tb\nc\nd\t\ne')).toBeNull()
  })

  it('行中间的空行断开等宽形状 → null', () => {
    expect(parseTsv('a\tb\n\nc\td')).toBeNull()
  })

  it('常量下限为 2×2', () => {
    expect(TSV_MIN_ROWS).toBe(2)
    expect(TSV_MIN_COLS).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// buildTableNode + 插件 handlePaste：最小 gfm 同构 schema（参照 table-input.test.ts）
// ---------------------------------------------------------------------------

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

describe('buildTableNode', () => {
  it('首行为表头行，其余为数据行，单元格文本经 paragraph 承载', () => {
    const table = buildTableNode(schema, [
      ['名称', '数量'],
      ['苹果', '3'],
    ])
    expect(table).not.toBeNull()
    expect(table!.type.name).toBe('table')
    const rows: PmNode[] = []
    table!.forEach((row) => rows.push(row))
    expect(rows.map((r) => r.type.name)).toEqual(['table_header_row', 'table_row'])
    const headCells: string[] = []
    rows[0].forEach((c) => headCells.push(c.textContent))
    expect(headCells).toEqual(['名称', '数量'])
    const bodyCells: string[] = []
    rows[1].forEach((c) => bodyCells.push(c.textContent))
    expect(bodyCells).toEqual(['苹果', '3'])
  })

  it('空单元格构建空 paragraph（满足 cellContent: paragraph）', () => {
    const table = buildTableNode(schema, [
      ['a', 'b'],
      ['', ''],
    ])
    const rowNames: string[] = []
    const bodyCellTypes: string[] = []
    void rowNames
    table!.forEach((row, _offset, _index) => {
      rowNames.push(row.type.name)
    })
    // 首行为表头行，取其后的首个数据行检查单元格内容类型
    let seen = 0
    table!.forEach((row) => {
      if (seen === 1) row.forEach((c) => bodyCellTypes.push(c.firstChild?.type.name ?? 'missing'))
      seen++
    })
    expect(rowNames).toEqual(['table_header_row', 'table_row'])
    expect(bodyCellTypes).toEqual(['paragraph', 'paragraph'])
  })

  it('schema 无表格节点时返回 null（调用方回退普通粘贴）', () => {
    const bare = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
      },
    })
    expect(
      buildTableNode(bare, [
        ['a', 'b'],
        ['c', 'd'],
      ]),
    ).toBeNull()
  })
})

describe('pasteTsv 插件 handlePaste', () => {
  // 测试只走 handlePaste（slice 参数在插件实现里未使用，类型上收窄为双参）
  const handlePaste = createPasteTsvPlugin().props.handlePaste as (
    view: unknown,
    event: unknown,
  ) => boolean
  const makeView = () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])])
    const state = EditorState.create({ doc, schema })
    const dispatched: unknown[] = []
    const view = {
      state,
      dispatch(tr: unknown) {
        dispatched.push(tr)
      },
    }
    return { view, dispatched, state }
  }

  const pasteEvent = (plain: string, html = '') => {
    const data = new Map([
      ['text/plain', plain],
      ['text/html', html],
    ])
    return {
      clipboardData: {
        getData: (t: string) => data.get(t) ?? '',
        files: [],
      },
      preventDefault: () => {},
    }
  }

  it('TSV 粘贴：构建表格并 dispatch，返回 true', () => {
    const { view, dispatched } = makeView()
    const handled = handlePaste(view, pasteEvent('名称\t数量\n苹果\t3\n'))
    expect(handled).toBe(true)
    expect(dispatched).toHaveLength(1)
    // 文档首块变为表格
    const tr = dispatched[0] as { doc: { firstChild: { type: { name: string } } } }
    expect(tr.doc.firstChild.type.name).toBe('table')
  })

  it('富文本优先：带 text/html 剪贴板时让位 HTML 管线（返回 false）', () => {
    const { view } = makeView()
    expect(handlePaste(view, pasteEvent('a\tb\nc\td', '<table></table>'))).toBe(false)
  })

  it('非 TSV 纯文本：返回 false 交给默认粘贴', () => {
    const { view } = makeView()
    expect(handlePaste(view, pasteEvent('普通一句话'))).toBe(false)
    expect(handlePaste(view, pasteEvent('只有一个制表符\t here'))).toBe(false)
  })
})
