/**
 * Typora 式表格输入：所见即所得里用「管道行 + 回车」即时建表。
 *
 * 背景：milkdown gfm 预设只提供 `|3x4| ` 快速建表规则与 InsertTable 命令，
 * 不存在「敲管道线文本自动成表」的输入规则——在段落里输入
 * `| a | b |` 永远只是普通段落。本插件补齐 Typora 的核心输入路径：
 *
 *   | 姓名 | 年龄 |      ← 普通段落输入表头，按回车
 *   ⏎                  → 即时转为真表格（表头 + 一行空数据行），
 *                        光标进入第一个数据单元格
 *
 * 另支持网格速记 `|3x5|`（整段恰好是 列x行 数字）按回车生成 3 列 5 行
 * 全空表格——与 gfm 预设 `|3x5|␣`（空格触发）同语义的建表结果；
 * gfm 原生规则只认空格结尾，Enter 路径由本插件补齐。
 *
 * 与 Typora 一致：不需要手动输入分隔行 `| -- | -- |`，表头行回车即成表，
 * 分隔行在序列化时由 mdast 自动生成。
 *
 * 为什么用 Enter 键规则而非文本 InputRule：管道行在输入过程中的每一帧
 * 几乎都是「合法前缀」（如刚敲完 `| a` 尚未打第 2 列时），文本规则
 * 会在用户继续输入途中提前成表；Typora 均以回车作为完成信号。
 *
 * 触发条件：
 * - 当前段落含至少一个未转义 |（排除普通文本与水平线 `---`）；
 * - 当前段落不是分隔行格式（`| -- | -- |` 不作为表头触发）；
 * - 仅文档顶层段落（引用块 / 列表项内不触发，depth≠1 直接放行）；
 * - 光标在段尾（段中回车走正常分段，不触发）；
 * - 段落不含硬换行（一段多物理行时不转换）。
 *
 * 同一插件还处理 Mod-Enter（Windows/Linux 为 Ctrl+Enter，macOS 为 Cmd+Enter）：
 * 光标在表格内时在当前行下方插入一空行（对齐 Typora 的 Command/Ctrl+Enter）；
 * 表格外直接放行，保持原行为。裸 Enter 仍按 gfm 预设语义跳出表格，
 * 单元格内换行统一走 Shift+Enter（插入 <br />）。
 *
 * 首版限制：
 * - 表头按纯文本入格（行内标记如 **粗体** 保留字面，成表后可再加标记）；
 * - 对齐方式默认为 null（左对齐），成表后可用表格工具栏设置 :-- / :-: / --:。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection } from '@milkdown/kit/prose/state'
import { TableMap, addRowAfter } from '@milkdown/kit/prose/tables'
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
 * 判断一行是否为分隔行（:-- / :-: / --: / --）。
 * 用于排除分隔行格式作为表头触发；不合法返回 null。
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

/** 网格表速记形态：整段恰为 `|列x行|`（大小写 x 均可），允许首尾空白 */
const GRID_SPEC_RE = /^\|(\d+)[xX](\d+)\|$/

/**
 * 解析 `|3x5|` 网格表速记（导出供单测）。
 *
 * 与 gfm 预设 insertTableInputRule 同语义：x 前为列数、x 后为行数，
 * 行数下限 2（gfm 的表格至少含表头行 + 一行数据行）。
 * 该速记由本插件的 Enter 键处理——gfm 原生规则以空白结尾触发（|3x5|␣），
 * 按 Enter 时会先被 tableFromPipeRow 拦截，故在此补齐 Enter 路径。
 *
 * @param text - 段落纯文本
 * @returns 列数与行数；非网格速记形态返回 null
 */
export function parseGridSpec(text: string): { cols: number; rows: number } | null {
  const m = text.trim().match(GRID_SPEC_RE)
  if (!m) return null
  return { cols: Number(m[1]), rows: Math.max(Number(m[2]), 2) }
}

// ---------------------------------------------------------------------------
// Enter 键规则：管道行段末回车 → 当前段落即时转真表格
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

/**
 * 按行列数构造全空网格表（表头行 + rows-1 行空数据行，与 gfm 预设的
 * createTable 结构一致，空表头对齐 Typora 的 |NxM| 行为）。
 */
function buildGridTableNode(state: EditorState, rows: number, cols: number) {
  const { schema } = state
  // createAndFill 在 schema 合法时必返回节点（cell 内容为 block+，自动补段落），
  // 但类型上为 Node | null，故先收集再用类型守卫收窄，与 buildTableNode 同一写法
  const isNode = (n: Node | null): n is Node => n !== null

  const headerCells = Array.from({ length: cols }, () =>
    schema.nodes[N.header].createAndFill({ alignment: null }),
  )
  if (!headerCells.every(isNode)) return null

  const dataRows: Node[] = []
  for (let i = 0; i < rows - 1; i++) {
    const cells = Array.from({ length: cols }, () =>
      schema.nodes[N.cell].createAndFill({ alignment: null }),
    )
    if (!cells.every(isNode)) return null
    dataRows.push(schema.nodes[N.dataRow].create(null, cells))
  }

  const headerRow = schema.nodes[N.headerRow].create(null, headerCells)
  return schema.nodes[N.table].create(null, [headerRow, ...dataRows])
}

/**
 * 管道行段末回车：当前段落含管道符且非分隔行时，替换为表格（导出供单测）。
 *
 * 两种触发形态：
 * - 网格速记 `|3x5|`（整段恰好是 列x行 数字）：生成对应行列的全空表格，
 *   对齐 gfm 预设 `|3x5|␣`（空格触发）的建表结果，补齐 Enter 路径；
 * - 普通管道行 `| a | b |`：表头文本入格生成 表头行 + 一行空数据行，
 *   对齐默认 null（成表后可用表格工具栏设置）。
 */
export function tableFromPipeRow(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from } = state.selection

  // 仅文档顶层段落：depth=1 = doc>paragraph（引用/列表内为 ≥3）
  if ($from.depth !== 1) return false
  if ($from.parent.type.name !== N.paragraph) return false
  // 光标须在段落末尾——段中回车是正常分段，不触发
  if ($from.parentOffset !== $from.parent.content.size) return false

  const text = $from.parent.textContent
  // 必须含至少一个未转义管道符（排除普通文本段落和水平线 ---）
  if (!/(?<!\\)\|/.test(text)) return false
  // 分隔行格式不作为表头触发（| -- | -- | 不成表）
  if (parseDelimiterRow(text)) return false

  // 网格速记优先：|3x5| 是「3 列 5 行空表」而非表头文字
  const grid = parseGridSpec(text)

  const headers = splitPipeRow(text)
  if (headers.length < 1) return false

  if (!dispatch) return true

  const table = grid
    ? buildGridTableNode(state, grid.rows, grid.cols)
    : buildTableNode(state, headers, headers.map(() => null))
  if (!table) return false

  // 替换当前段落为表格
  const rangeStart = $from.before(1)
  const rangeEnd = $from.after(1)
  // closeHistory：成表事务强制成为独立撤销组。否则替换范围与上一步
  // 输入范围相交（段落尾部在替换区间内），prosemirror-history 会把
  // 连续输入与成表并成一组，一次 Cmd+Z 把敲好的表头文本一起撤没
  const tr = closeHistory(state.tr.replaceWith(rangeStart, rangeEnd, table))

  moveCaretIntoFirstDataCell(tr, rangeStart)
  dispatch(tr)
  return true
}

/**
 * 成表后把光标放进第一行数据单元格的空段落（row=1：0 是表头行）。
 * TableMap 的偏移相对 table 内容起点：cell 前 = tablePos+1+rel，
 * 再越过 cell 开 token(+1) 与 paragraph 开 token(+1) 到段落内。
 */
function moveCaretIntoFirstDataCell(tr: Transaction, tablePos: number): void {
  const inserted = tr.doc.nodeAt(tablePos)
  if (!inserted) return
  const rel = TableMap.get(inserted).positionAt(1, 0, inserted)
  const firstDataCellInner = tablePos + 1 + rel + 2
  tr.setSelection(TextSelection.create(tr.doc, firstDataCellInner)).scrollIntoView()
}

/**
 * 表格内 Mod-Enter：在当前行下方插入一空行（导出供单测）。
 *
 * 作用域门闩：仅当光标位于表格内时拦截按键，委托 prosemirror-tables 的
 * addRowAfter（与表格悬浮工具栏「下方加行」同一命令）；表格外返回 false
 * 交还按键链，保持 Mod-Enter 原行为不变。Mod 在 Windows/Linux 为 Ctrl、
 * macOS 为 Cmd，一个绑定双平台生效。
 *
 * @param state - 当前编辑器状态
 * @param dispatch - 事务分发函数；省略时仅查询命令是否可用
 * @returns 表格内且插行成功返回 true；表格外返回 false
 */
export function addRowOnModEnter(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from } = state.selection
  // 向上遍历祖先链判定是否处于表格内（单元格内深度至少为 doc>table>row>cell）
  let inTable = false
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === N.table) {
      inTable = true
      break
    }
  }
  if (!inTable) return false
  return addRowAfter(state, dispatch)
}

/**
 * 表格按键插件（晚于 gfm 注册）：
 * - Enter：顶层段落管道行段末回车即时成表；表格内 depth≠1 放行，
 *   由 gfm 的 ExitTable 处理（跳出表格）
 * - Mod-Enter：表格内在当前行下方插入空行；表格外放行
 */
export const tableInputPlugin = $prose(() =>
  keymap({ Enter: tableFromPipeRow, 'Mod-Enter': addRowOnModEnter }),
)
