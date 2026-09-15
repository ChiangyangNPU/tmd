/**
 * 表格悬浮工具栏：光标进入表格时在表格上方弹出（行/列增删、当前列对齐、删除整表）。
 *
 * - 命令直接复用 prosemirror-tables（@milkdown/prose/tables）：加行/加列基于
 *   光标 selection 即可；删行/删列与对齐基于「选中整行/列」的 CellSelection，
 *   选区与删除合并为一次 dispatch（单步撤销）
 * - 删到最后一行/列时 prosemirror-tables 自动删除整个表格
 * - 删除整表（table-delete）：工具栏最右侧垃圾桶图标，整体移除 table 节点，
 *   删除后文档为空时补一个空段落承接光标（doc 内容要求 block+）
 * - 列宽拖拽由 gfm 预设内置的 columnResizing 插件提供（colwidth 存入 cell
 *   attrs；GFM 纯文本不含宽度，重新打开后恢复默认——格式限制）
 * - 显隐与定位：PluginView 每次 transaction 更新；监听滚动重定位；
 *   源码模式下 PM 未挂载，自然不出现
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import {
  CellSelection,
  TableMap,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  setCellAttr,
} from '@milkdown/kit/prose/tables'
import type { Command } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** 光标所在表格上下文：table 节点/位置 + 当前行列（TableMap 计算） */
export interface TableContext {
  table: ProseNode
  tablePos: number
  map: TableMap
  row: number
  col: number
}

/** 从选区解析所在表格与当前单元格行列（无表格返回 null） */
export function findTableContext(state: {
  selection: { $from: ResolvedPosLike }
}): TableContext | null {
  const { $from } = state.selection
  let cellPos = -1
  let table: ProseNode | null = null
  let tablePos = -1
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (cellPos < 0 && (node.type.name === 'table_cell' || node.type.name === 'table_header')) {
      cellPos = $from.before(d)
    }
    if (node.type.name === 'table') {
      table = node
      tablePos = $from.before(d)
      break
    }
  }
  if (!table || tablePos < 0 || cellPos < 0) return null
  const map = TableMap.get(table)
  const cellRect = map.findCell(cellPos - tablePos - 1)
  return { table, tablePos, map, row: cellRect.top, col: cellRect.left }
}

/** 兼容类型：测试里用最小桩即可满足（真正运行时是 ProseMirror ResolvedPos） */
interface ResolvedPosLike {
  depth: number
  node(depth: number): ProseNode
  before(depth: number): number
}

/** 选区内整行/列的单元格绝对位置（升序） */
function lineCellPositions(ctx: TableContext, kind: 'row' | 'col'): number[] {
  const rect =
    kind === 'row'
      ? { left: 0, right: ctx.map.width, top: ctx.row, bottom: ctx.row + 1 }
      : { left: ctx.col, right: ctx.col + 1, top: 0, bottom: ctx.map.height }
  return ctx.map.cellsInRect(rect).map((rel) => ctx.tablePos + 1 + rel)
}

/** 构造选中整行/列的 CellSelection 并执行命令（同一事务，单步撤销） */
function runOnLineSelection(
  state: Parameters<Command>[0],
  dispatch: Parameters<Command>[1],
  kind: 'row' | 'col',
  cmd: Command,
): boolean {
  const ctx = findTableContext(state)
  if (!ctx) return false
  const positions = lineCellPositions(ctx, kind)
  if (!positions.length) return false
  const selState = state.apply(
    state.tr.setSelection(
      CellSelection.create(state.doc, positions[0], positions[positions.length - 1]),
    ),
  )
  return cmd(selState, dispatch)
}

/** 工具栏动作：view + dispatch 的统一签名 */
export type TableAction = (view: EditorView) => boolean

/** 对齐当前列：构造列选区后 setCellAttr（相同值重复点击会被重置为默认左对齐） */
function alignColumn(view: EditorView, alignment: 'left' | 'center' | 'right'): boolean {
  return runOnLineSelection(view.state, view.dispatch, 'col', setCellAttr('alignment', alignment))
}

/**
 * 删除整个表格：在当前事务内整体移除 table 节点（单步撤销），
 * 光标落到表格原位置后的最近文本位置（表格在文档末尾时回落到上一块）。
 */
function deleteTable(state: Parameters<Command>[0], dispatch: Parameters<Command>[1]): boolean {
  const ctx = findTableContext(state)
  if (!ctx) return false
  if (!dispatch) return true
  const { tablePos, table } = ctx
  // 删除范围与建表/上次输入的范围完全重合，不打断历史会与上一步并成一组，
  // 一次 Cmd+Z 直接退回建表前的原文（表格无法单独撤销回来）
  let tr = closeHistory(state.tr.delete(tablePos, tablePos + table.nodeSize))
  // doc 内容要求 block+：表格是唯一块时删除后文档为空，补一个空段落承接光标
  if (tr.doc.childCount === 0) tr = tr.insert(0, state.schema.nodes.paragraph.create())
  const $pos = tr.doc.resolve(Math.min(tablePos, tr.doc.content.size))
  dispatch(tr.setSelection(TextSelection.near($pos, 1)).scrollIntoView())
  return true
}

/** 工具栏动作表（data-tt-action → 命令） */
export const TABLE_ACTIONS: Record<string, TableAction> = {
  'row-before': (v) => addRowBefore(v.state, v.dispatch),
  'row-after': (v) => addRowAfter(v.state, v.dispatch),
  'row-delete': (v) => runOnLineSelection(v.state, v.dispatch, 'row', deleteRow),
  'col-before': (v) => addColumnBefore(v.state, v.dispatch),
  'col-after': (v) => addColumnAfter(v.state, v.dispatch),
  'col-delete': (v) => runOnLineSelection(v.state, v.dispatch, 'col', deleteColumn),
  'align-left': (v) => alignColumn(v, 'left'),
  'align-center': (v) => alignColumn(v, 'center'),
  'align-right': (v) => alignColumn(v, 'right'),
  'table-delete': (v) => deleteTable(v.state, v.dispatch),
}

/** 执行工具栏动作（main.ts 绑定按钮时调用；源码模式无 PM 视图，忽略） */
export function runTableAction(view: EditorView, action: string): boolean {
  const cmd = TABLE_ACTIONS[action]
  if (!cmd) return false
  const ok = cmd(view)
  if (ok) view.focus()
  return ok
}

/** 工具栏按钮事件绑定（boot 调用一次；view 由调用方提供，源码模式返回 null 即忽略） */
export function wireTableToolbar(getView: () => EditorView | null): void {
  document.querySelectorAll<HTMLButtonElement>('#table-toolbar .tt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = getView()
      if (!view) return
      runTableAction(view, btn.dataset.ttAction ?? '')
    })
  })
}

// ---------------------------------------------------------------------------
// 悬浮工具栏显隐与定位（PluginView）
// ---------------------------------------------------------------------------

const VIEWPORT_MARGIN = 8

class TableToolbarView {
  #view: EditorView
  #el: HTMLElement
  #reposition = () => this.#render()

  constructor(view: EditorView) {
    this.#view = view
    this.#el = document.getElementById('table-toolbar') as HTMLElement
    window.addEventListener('scroll', this.#reposition, true)
    window.addEventListener('resize', this.#reposition)
  }

  update(view: EditorView): void {
    this.#view = view
    this.#render()
  }

  /** 光标在表格内则显示并定位到表格上方居中，否则隐藏 */
  #render(): void {
    if (!this.#el) return
    const ctx = findTableContext(this.#view.state)
    if (!ctx) {
      this.#el.hidden = true
      return
    }
    const dom = this.#view.nodeDOM(ctx.tablePos) as HTMLElement | null
    if (!dom) {
      this.#el.hidden = true
      return
    }
    const rect = dom.getBoundingClientRect()
    this.#el.hidden = false
    const left = rect.left + rect.width / 2 - this.#el.offsetWidth / 2
    const top = rect.top - this.#el.offsetHeight - 6
    this.#el.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - this.#el.offsetWidth - VIEWPORT_MARGIN))}px`
    this.#el.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`
  }

  destroy(): void {
    window.removeEventListener('scroll', this.#reposition, true)
    window.removeEventListener('resize', this.#reposition)
    this.#el.hidden = true // 编辑器销毁/重建（切源码模式、换标签）时隐藏残留
  }
}

/** 表格工具栏插件：挂 PluginView，随事务更新显隐与位置 */
export const tableToolbar = $prose(
  () =>
    new Plugin({
      view: (view) => new TableToolbarView(view),
    }),
)
