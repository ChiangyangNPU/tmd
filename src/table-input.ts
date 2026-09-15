/**
 * Typora 式表格输入：所见即所得里用「表头行 + 分隔行 + 回车」即时建表。
 *
 * 背景：milkdown gfm 预设只提供 `|3x4| ` 快速建表规则与 InsertTable 命令，
 * 不存在「敲管道线文本自动成表」的输入规则——在段落里逐行输入
 * `| a | b |` / `| -- | -- |` 永远只是两个段落，GFM 语法上也成不了表。
 * 本插件补齐 Typora/Obsidian 的核心输入路径：
 *
 *   | 姓名 | 年龄 |      ← 普通段落输入表头，回车
 *   | -- | -- |        ← 输入分隔行，再按回车
 *   ⏎                  → 两行即时转为真表格（表头 + 一行空数据行），
 *                        光标进入第一个数据单元格
 *
 * 为什么用 Enter 键规则而非文本 InputRule：分隔行在输入过程中的每一帧
 * 几乎都是「合法前缀」（如刚敲完 `| -- | --` 尚未打第 3 列时），文本规则
 * 会在用户继续输入途中提前成表；Typora/Obsidian 均以回车作为完成信号。
 *
 * 解析规则与 GFM 对齐：
 * - 首尾管道符可省略；按未转义的 | 分列；单元格空白允许（表头格可为空）；
 * - 分隔单元格为 :?-+:? 形态，冒号位置映射 left/center/right 对齐；
 * - 整行必须含至少一个 |，避免把 `---`（水平线）误判成单列分隔行；
 * - 表头行数与分隔行列数一致才转换。
 *
 * 首版限制：
 * - 仅支持文档顶层段落（引用块 / 列表项内不触发，depth≠1 直接放行）；
 * - 表头按纯文本入格（行内标记如 **粗体** 保留字面，成表后可再加标记）；
 * - 表头段落含硬换行（一段多物理行）时不转换。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection } from '@milkdown/kit/prose/state'
import { TableMap } from '@milkdown/kit/prose/tables'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { Node } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

// ---------------------------------------------------------------------------
// 纯函数层：管道行解析（不依赖 ProseMirror，便于单测）
// ---------------------------------------------------------------------------

export type CellAlign = 'left' | 'center' | 'right' | null

/** 单个分隔单元格的合法形态：可选首尾冒号 + 至少一个短横 */
const DELIM_CELL_RE = /^:?-+:?$/

/**
 * 切分管道行为单元格：去掉可选的首尾 |，按「未被反斜杠转义的 |」分列并 trim。
 * 转义管道符 \\| 还原为字面 |（与 GFM 表格单元格语义一致）。
 */
export function splitPipeRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/**
 * 解析分隔行为每列对齐方式；不合法返回 null。
 * 例：`| :-- | :-: | --: |` → ['left', 'center', 'right']
 */
export function parseDelimiterRow(line: string): CellAlign[] | null {
  // 必须含至少一个管道符：否则 `---` 水平线、`-` 列表会被误判成单列分隔
  if (!/(?<!\\)\|/.test(line)) return null
  const cells = splitPipeRow(line)
  if (cells.length === 0) return null
  const aligns: CellAlign[] = []
  for (const cell of cells) {
    if (!DELIM_CELL_RE.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null)
  }
  return aligns
}

/**
 * 解析表头行；列数与分隔行不一致（或含物理换行）时返回 null。
 * 单元格允许空文本（空表头列）。
 */
export function parseHeaderRow(line: string, cols: number): string[] | null {
  if (line.includes('\n')) return null
  const cells = splitPipeRow(line)
  return cells.length === cols ? cells : null
}

// ---------------------------------------------------------------------------
// Enter 键规则：分隔行段末回车 → 与上一段表头合并转真表格
// ---------------------------------------------------------------------------

/** gfm 预设的表格相关节点名（@milkdown/preset-gfm schema 注册名） */
const N = {
  table: 'table',
  headerRow: 'table_header_row',
  dataRow: 'table_row',
  header: 'table_header',
  cell: 'table_cell',
  paragraph: 'paragraph',
} as const

/**
 * 按表头文本与对齐构造 gfm 表格节点（表头行 + 一行空数据行，与 Typora 一致）。
 */
function buildTableNode(state: EditorState, headers: string[], aligns: CellAlign[]) {
  const { schema } = state
  const headerCells = headers.map((text, i) => {
    const attrs = { alignment: aligns[i] }
    // 空表头：createAndFill 自动补空段落；非空：显式包一层 paragraph+text
    if (!text) return schema.nodes[N.header].createAndFill(attrs)
    const para = schema.nodes[N.paragraph].create(null, schema.text(text))
    return schema.nodes[N.header].createAndFill(attrs, para)
  })
  const dataCells = aligns.map((alignment) => schema.nodes[N.cell].createAndFill({ alignment }))
  // createAndFill 在 schema 合法时必返回节点（cell 内容为 block+，自动补段落）
  const isNode = (n: Node | null): n is Node => n !== null
  if (!headerCells.every(isNode) || !dataCells.every(isNode)) return null
  const headerRow = schema.nodes[N.headerRow].create(null, headerCells)
  const dataRow = schema.nodes[N.dataRow].create(null, dataCells)
  return schema.nodes[N.table].create(null, [headerRow, dataRow])
}

/** 分隔行段末回车：命中则把「上一段表头 + 当前分隔行」替换为表格（导出供单测） */
export function tableFromDelimiter(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from } = state.selection

  // 仅文档顶层段落：depth=1 = doc>paragraph（引用/列表内为 ≥3）
  if ($from.depth !== 1) return false
  if ($from.parent.type.name !== N.paragraph) return false
  // 光标须在段落末尾——段中回车是正常分段，不触发
  if ($from.parentOffset !== $from.parent.content.size) return false

  const aligns = parseDelimiterRow($from.parent.textContent)
  if (!aligns) return false

  // 取当前段落的前一个兄弟块作为表头；分隔行位于文档首行时无表头
  const paraStart = $from.before(1)
  if (paraStart === 0) return false
  const headerNode = state.doc.resolve(paraStart).nodeBefore
  if (!headerNode || headerNode.type.name !== N.paragraph) return false
  const headers = parseHeaderRow(headerNode.textContent, aligns.length)
  if (!headers) return false

  if (!dispatch) return true

  const table = buildTableNode(state, headers, aligns)
  if (!table) return false

  // 替换范围：表头段落起点 → 分隔段落终点（顶层兄弟紧邻，起点直接相减）
  const rangeStart = paraStart - headerNode.nodeSize
  const rangeEnd = $from.after(1)
  // closeHistory：成表事务强制成为独立撤销组。否则替换范围与上一步
  // 输入范围相交（分隔行尾部在替换区间内），prosemirror-history 会把
  // 连续输入与成表并成一组，一次 Cmd+Z 把敲好的两行文本一起撤没
  const tr = closeHistory(state.tr.replaceWith(rangeStart, rangeEnd, table))

  // 光标进入第一行数据单元格的空段落（row=1：0 是表头行）
  // TableMap 的偏移相对 table 内容起点：cell 前 = tablePos+1+rel，
  // 再越过 cell 开 token(+1) 与 paragraph 开 token(+1) 到段落内
  const inserted = tr.doc.nodeAt(rangeStart)
  if (inserted) {
    const rel = TableMap.get(inserted).positionAt(1, 0, inserted)
    const firstDataCellInner = rangeStart + 1 + rel + 2
    tr.setSelection(TextSelection.create(tr.doc, firstDataCellInner)).scrollIntoView()
  }
  dispatch(tr)
  return true
}

/** 表格输入插件（晚于 gfm 注册；只在顶层段落生效，不影响表格内 Enter） */
export const tableInputPlugin = $prose(() => keymap({ Enter: tableFromDelimiter }))
