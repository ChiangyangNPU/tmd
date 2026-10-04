/**
 * TSV 粘贴转表格：纯文本剪贴板里的「制表符分隔多行数据」自动转为表格。
 *
 * - 触发条件严格：无 text/html 剪贴板（Excel/网页富文本优先走 HTML 转换
 *   管线，paste-image 优先级更高）且纯文本至少 2 行 × 2 列——普通句子里的
 *   单个制表符不会误触；列数不齐的文本视为非表格数据原样粘贴
 * - 直接构建 ProseMirror 表格节点（首个数据行作表头，单元格经 paragraph
 *   承载，与 gfm 预设 schema 同构）；插入到光标处，落在表格内时在其后补
 *   一个空段落承接光标，粘贴完立即可继续写作
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { Schema } from '@milkdown/kit/prose/model'
import type { Node as PmNode } from '@milkdown/kit/prose/model'

/** 最小形状：2 行 × 2 列（低于此形状按普通文本粘贴） */
export const TSV_MIN_ROWS = 2
export const TSV_MIN_COLS = 2

/**
 * 解析 TSV 文本为二维数组；非 TSV 形状返回 null。
 * 形状判定：至少 TSV_MIN_ROWS 行、每行列数一致且 ≥ TSV_MIN_COLS；
 * 剪贴板末尾的换行容忍（Excel 复制恒带），行中间的空行视为非表格数据。
 * 不支持带引号换行的 TSV（Excel 剪贴板纯文本导出从不加引号，已知边界）。
 */
export function parseTsv(text: string): string[][] | null {
  if (!text || !text.includes('\t')) return null
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length < TSV_MIN_ROWS) return null
  const rows = lines.map((line) => line.split('\t'))
  const cols = rows[0].length
  if (cols < TSV_MIN_COLS) return null
  if (rows.some((row) => row.length !== cols)) return null
  return rows
}

/**
 * 二维数组 → ProseMirror 表格节点：首行 table_header_row（table_header），
 * 其余 table_row（table_cell），单元格内容走 paragraph（gfm schema 的
 * cellContent）。schema 缺表格节点时返回 null（调用方回退普通粘贴）。
 */
export function buildTableNode(schema: Schema, rows: string[][]): PmNode | null {
  const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
  if (!table || !table_header_row || !table_row || !table_header || !table_cell || !paragraph) {
    return null
  }
  const cell = (type: typeof table_header, text: string) =>
    type.create(null, paragraph.create(null, text ? schema.text(text) : undefined))
  const [head, ...body] = rows
  return table.create(null, [
    table_header_row.create(
      null,
      head.map((c) => cell(table_header, c)),
    ),
    ...body.map((row) =>
      table_row.create(
        null,
        row.map((c) => cell(table_cell, c)),
      ),
    ),
  ])
}

/** ProseMirror 插件工厂（独立导出供单测直接构造；编辑器经 pasteTsv 消费） */
export function createPasteTsvPlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste: (view, event) => {
        if (event.clipboardData?.getData('text/html')) return false
        if (event.clipboardData?.files.length) return false
        const rows = parseTsv(event.clipboardData?.getData('text/plain') ?? '')
        if (!rows) return false
        const table = buildTableNode(view.state.schema, rows)
        if (!table) return false
        event.preventDefault()
        const tr = view.state.tr
        tr.replaceSelectionWith(table)
        // 光标落在表格内时，在表格后补空段落并移入（表后立即可继续写作）
        const $pos = tr.selection.$from
        let insideTable = false
        for (let d = $pos.depth; d > 0; d--) {
          if ($pos.node(d).type === table.type) {
            insideTable = true
            break
          }
        }
        if (insideTable) {
          const end = tr.doc.content.size
          tr.insert(end, view.state.schema.nodes.paragraph.create())
          tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)))
        }
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  })
}

export const pasteTsv = $prose(() => createPasteTsvPlugin())
