import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Table, TableCell } from 'mdast'
import {
  normalizeEmptyTableCells,
  tableHardbreakBreakHandler,
  tableCellBrRemark,
  patchTableHardbreak,
} from '../table-markdown'

// ---------------------------------------------------------------------------
// normalizeEmptyTableCells：空单元格占位清理
// ---------------------------------------------------------------------------

describe('normalizeEmptyTableCells', () => {
  it('清空仅含 <br /> 的空单元格（新插入行列的占位）', () => {
    const input = '| a | <br /> |\n| --- | --- |\n| b |  |'
    expect(normalizeEmptyTableCells(input)).toBe('| a | |\n| --- | --- |\n| b |  |')
  })

  it('一行内多个空单元格全部清空', () => {
    expect(normalizeEmptyTableCells('| <br /> | <br /> |')).toBe('| | |')
  })

  it('<br> 无自闭合斜杠、带空格变体同样清空', () => {
    expect(normalizeEmptyTableCells('| x |<br>|')).toBe('| x | |')
    expect(normalizeEmptyTableCells('| x | <br/> |')).toBe('| x | |')
  })

  it('单元格内的合法换行（文字 + <br />）不受影响', () => {
    const input = '| a<br />b | c |'
    expect(normalizeEmptyTableCells(input)).toBe(input)
  })

  it('用户字面输入的转义 \\<br /> 不受影响（html:false 序列化形态）', () => {
    const input = '| \\<br /> | x |'
    expect(normalizeEmptyTableCells(input)).toBe(input)
  })

  it('正文中的 <br /> 空行占位不受影响（非表格）', () => {
    const input = '第一段\n\n<br />\n\n第二段'
    expect(normalizeEmptyTableCells(input)).toBe(input)
  })

  it('无表格内容原样返回', () => {
    const input = '# 标题\n\n正文段落。'
    expect(normalizeEmptyTableCells(input)).toBe(input)
  })

  it('幂等：重复规范化结果不变', () => {
    const once = normalizeEmptyTableCells('| a | <br /> |')
    expect(normalizeEmptyTableCells(once)).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// tableHardbreakBreakHandler：序列化方向（stringify break handler）
// ---------------------------------------------------------------------------

/** 构造最小 to-markdown state（捕获 safe 调用参数） */
function mkStringifyState(stack: string[]) {
  const calls: Array<{ value: string; info: unknown }> = []
  const safe = (value: string, info: unknown) => {
    calls.push({ value, info })
    return `SAFE(${JSON.stringify(value)})`
  }
  return { state: { stack, lineEnding: '\n', safe }, calls }
}

describe('tableHardbreakBreakHandler（hardbreak 序列化）', () => {
  it('表格单元格内输出 <br />（物理换行会被 gfm-table 压扁为空格）', () => {
    const { state } = mkStringifyState(['phrasing', 'tableCell'])
    expect(tableHardbreakBreakHandler(null, null, state, {})).toBe('<br />')
  })

  it('表格外保持 commonmark 默认的「反斜杠 + 换行」（经 safe 转义）', () => {
    const { state, calls } = mkStringifyState(['phrasing'])
    const out = tableHardbreakBreakHandler(null, null, state, { before: 'x' })
    expect(out).toBe('SAFE("\\\\\\n")')
    expect(calls).toEqual([{ value: '\\\n', info: { before: 'x' } }])
  })

  it('跟随 state.lineEnding 配置（CRLF 场景）', () => {
    const state = { stack: ['phrasing'], lineEnding: '\r\n', safe: (v: string) => v }
    expect(tableHardbreakBreakHandler(null, null, state, {})).toBe('\\\r\n')
  })
})

// ---------------------------------------------------------------------------
// tableCellBrRemark：解析方向（格内 <br> html 节点 → break）
// ---------------------------------------------------------------------------

/** parse 真实 GFM markdown 为 mdast 树 */
function parseTable(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown)
}

/** 运行裸 remark transformer（与 milkdown parser 的 runSync 同路径） */
function runCellBrRemark(tree: Root): Root {
  return unified().use(tableCellBrRemark).runSync(tree)
}

/** 取文档中第一张表格的全部单元格 */
function tableCells(tree: Root): TableCell[] {
  const table = tree.children.find((node): node is Table => node.type === 'table')
  expect(table, '用例需要含表格').toBeTruthy()
  return table ? table.children.flatMap((row) => row.children) : []
}

describe('tableCellBrRemark（格内 <br> 标签还原为 hardbreak）', () => {
  it('单元格内独立 <br /> 节点替换为 break（hardbreak parser 据此还原）', () => {
    const tree = runCellBrRemark(parseTable('| a<br />b | c |\n| --- | --- |'))
    const [firstCell] = tableCells(tree)
    expect(firstCell?.children.map((n) => n.type)).toEqual(['text', 'break', 'text'])
  })

  it('<br> 无斜杠、大写、额外空白等变体同样替换', () => {
    const tree = runCellBrRemark(parseTable('| x<br>y<br/>z<BR />w | |\n| --- | --- |'))
    const [firstCell] = tableCells(tree)
    expect(firstCell?.children.map((n) => n.type)).toEqual([
      'text', 'break', 'text', 'break', 'text', 'break', 'text',
    ])
  })

  it('整格唯一 <br />（空段落占位）不转换 —— 交给 commonmark 占位回收', () => {
    const tree = runCellBrRemark(parseTable('| a | <br /> |\n| --- | --- |'))
    const cells = tableCells(tree)
    expect(cells[1]?.children.map((n) => n.type)).toEqual(['html'])
  })

  it('仅含空白文本与 <br> 的单元格仍视为占位格', () => {
    const tree = runCellBrRemark(parseTable('| a |   <br />   |\n| --- | --- |'))
    const cells = tableCells(tree)
    expect(cells[1]?.children.some((n) => n.type === 'break')).toBe(false)
  })

  it('表格外的 <br /> html 节点不处理', () => {
    const tree = runCellBrRemark(parseTable('a<br />b\n\n| c | d |\n| --- | --- |'))
    const para = tree.children[0]
    expect(para?.type).toBe('paragraph')
    expect(para.type === 'paragraph' && para.children.map((n) => n.type)).toEqual([
      'text', 'html', 'text',
    ])
  })

  it('非 <br> 的其他 inline html（如 <span>）不处理', () => {
    const tree = runCellBrRemark(parseTable('| a<span>b | c |\n| --- | --- |'))
    const [firstCell] = tableCells(tree)
    expect(firstCell?.children.map((n) => n.type)).toEqual(['text', 'html', 'text'])
  })

  it('幂等：重复运行结果稳定（break 节点不会被二次转换）', () => {
    const once = runCellBrRemark(parseTable('| a<br />b | c |\n| --- | --- |'))
    const twice = runCellBrRemark(structuredClone(once))
    expect(twice).toEqual(once)
  })
})

// ---------------------------------------------------------------------------
// patchTableHardbreak：ctx 装配
// ---------------------------------------------------------------------------

describe('patchTableHardbreak', () => {
  /** 伪造 Ctx：捕获 update 的变换函数 */
  function runPatch(prev: unknown) {
    let updater: ((v: unknown) => unknown) | null = null
    const ctx = { update: (_s: unknown, fn: (v: unknown) => unknown) => void (updater = fn) }
    patchTableHardbreak(ctx as never)
    return updater!(prev) as { handlers?: Record<string, unknown>; encode?: unknown[] }
  }

  it('合入 break handler，保留既有 handlers 与其他选项', () => {
    const keep = () => 'keep'
    const next = runPatch({ handlers: { text: keep, strong: keep }, encode: [] })
    expect(next.handlers?.break).toBe(tableHardbreakBreakHandler)
    expect(next.handlers?.text).toBe(keep)
    expect(next.handlers?.strong).toBe(keep)
    expect(next.encode).toEqual([])
  })
})
