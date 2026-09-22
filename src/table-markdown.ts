/**
 * 表格 Markdown 规范化与单元格硬换行支持。
 *
 * 一、空单元格占位清理（normalizeEmptyTableCells）
 *
 * 背景：Milkdown commonmark 的段落序列化器对「非文档末尾的空段落」统一输出
 * <br />（remarkPreserveEmptyLinePlugin 补偿，用于保留正文空行）。表格里新插入
 * 的行/列是空段落 cell，导出变成 `| <br /> |`；且同一表格行内出现 raw-HTML 后，
 * remark 会把相邻文本连带转义为 code 反引号包裹（数据污染）。
 *
 * 尝试过 extendSchema 覆盖 table_cell 的 toMarkdown：与 gfm 预设的同名 schema
 * 双注册会破坏编辑器插件链（表格工具栏插件失效，已实测），故改为序列化后
 * 处理——与 fillTocBlocks 同一模式，在 currentMarkdown 出口统一规范化。
 *
 * 安全性：html:false 下用户字面输入的 `<br />` 序列化时带反斜杠转义（`\<br />`），
 * 不会被匹配；单元格内「文字 + 换行」的合法 hardbreak（如 `a<br />b`）也不匹配——
 * 只有「| 后紧跟 <br/> 再紧跟 |」的整格占位会被清空。GFM 允许空单元格，
 * remark 解析往返稳定，GitHub/VS Code 等渲染正常。
 *
 * 二、单元格硬换行支持（Shift+Enter）
 *
 * 放开 commonmark 的 hardbreakFilterNodes 表格禁令后，Shift+Enter 能在单元格
 * 内插入 hardbreak，但两个序列化环节仍会丢失换行：
 *
 * 1. 序列化方向（patchTableHardbreak 覆盖 stringify 的 break handler）：
 *    commonmark 把 hardbreak 序列化为 mdast break，默认 handler 输出反斜杠+
 *    物理换行，而 mdast-util-gfm-table 序列化单元格时会把物理换行压扁成空格
 *    （`a␊b` → `a b`）。注意 milkdown 序列化器走的是 processor.stringify(tree)，
 *    不执行 remark transformer，故只能覆盖 handler：state.stack 命中
 *    'tableCell' 时直接返回 `<br />`（GitHub/Typora 通用的格内换行写法，
 *    不含物理换行，表格行结构不被破坏）；表格外保持「反斜杠 + 换行」原行为。
 *
 * 2. 解析方向（tableHardbreakPlugin remark 插件）：外部 markdown 中格内的
 *    `<br>` 标签经 remark-parse 成为 inline html 节点，本插件把它替换为 break，
 *    再由 commonmark 的 hardbreak parser 还原为 hardbreak。必须早于 commonmark
 *    注册——其 remarkPreserveEmptyLinePlugin 会无差别删除所有 <br> html 节点
 *    （正文空行占位回收）。整格仅一个 <br> 的空占位格不转换，交给该插件删除，
 *    空单元格仍回到空段落语义。
 *
 * @author chiangyang
 */
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { $remark } from '@milkdown/kit/utils'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Root } from 'mdast'
import type { Plugin } from 'unified'

/** 「| + 纯 <br/> 占位 + |」的空单元格模式（| 为消费边界，(?=|) 前瞻保后续匹配） */
const EMPTY_CELL_BR = /(\|)\s*<br\s*\/?\s*>\s*(?=\|)/g

/** 清空仅含 <br /> 占位的空单元格（currentMarkdown 出口调用） */
export function normalizeEmptyTableCells(markdown: string): string {
  return markdown.replace(EMPTY_CELL_BR, '$1 ')
}

// ---------------------------------------------------------------------------
// 序列化方向：stringify break handler 覆盖
// ---------------------------------------------------------------------------

/** mdast-util-to-markdown 序列化状态的最小结构（仅实际用到的字段） */
interface StringifyStateLike {
  /** 当前进入的构造名栈（gfm-table 序列化单元格时压入 'tableCell'） */
  stack?: string[]
  /** 换行符（默认 LF，与 milkdown 默认配置一致） */
  lineEnding?: string
  /** 对内联输出做转义保护 */
  safe(value: string, info: Record<string, unknown>): string
}

/** 统一输出的换行标签写法 */
const BR_TAG_HTML = '<br />'

/**
 * hardbreak 的序列化 handler：
 * - 表格单元格内输出 `<br />`（物理换行会被 gfm-table 压扁为空格）；
 * - 表格外保持 commonmark 默认的「反斜杠 + 换行」。
 *
 * @param _node - mdast break 节点（无字段使用）
 * @param _parent - 父节点（未使用）
 * @param state - to-markdown 序列化状态
 * @param info - 当前内联安全上下文（before/after 等）
 * @returns 实际写入 markdown 的文本
 */
export function tableHardbreakBreakHandler(
  _node: unknown,
  _parent: unknown,
  state: StringifyStateLike,
  info: Record<string, unknown>,
): string {
  if (state.stack?.includes('tableCell')) return BR_TAG_HTML
  return state.safe(`\\${state.lineEnding ?? '\n'}`, info)
}

/**
 * 覆盖 stringify 的 break handler（editor-core 的 config 装配中调用）。
 * 与 patchTextEscaping 同模式：合入既有 handlers，不影响其他节点序列化。
 *
 * @param ctx - Milkdown 编辑器上下文
 */
export function patchTableHardbreak(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (prev) => {
    const options = prev as { handlers?: Record<string, unknown> } & Record<string, unknown>
    return {
      ...options,
      handlers: { ...options.handlers, break: tableHardbreakBreakHandler },
    } as unknown as typeof prev
  })
}

// ---------------------------------------------------------------------------
// 解析方向：格内 <br> html 节点 → break（remark transformer，parser 路径生效）
// ---------------------------------------------------------------------------

/** mdast 节点的最小结构（转换只用到 type/value/children） */
interface MdastNodeLike {
  type: string
  value?: string
  children?: MdastNodeLike[]
}

/** 磁盘上独立 <br> 标签的常见写法（大小写、空白、自闭合斜杠均可） */
const BR_TAG_RE = /^<br\s*\/?>$/i

/**
 * 判断单元格内是否存在实质内容：
 * 非空白文本，或 html/text 以外的节点（图片、链接、行内代码等）均算内容。
 * 整格仅含空白文本与 <br> 时视为「空段落占位格」。
 */
function cellHasContent(children: MdastNodeLike[]): boolean {
  return children.some(
    (node) =>
      (node.type === 'text' && (node.value ?? '').trim() !== '') ||
      (node.type !== 'text' && node.type !== 'html'),
  )
}

/**
 * 把单个 tableCell 内、有实质内容单元格中的独立 <br> html 节点替换为 break。
 * 空占位格不处理：交由 commonmark 的 remarkPreserveEmptyLinePlugin 删除。
 */
function convertCellBrTags(cell: MdastNodeLike): void {
  if (!cell.children || !cellHasContent(cell.children)) return
  cell.children = cell.children.map((node) =>
    node.type === 'html' && BR_TAG_RE.test((node.value ?? '').trim()) ? { type: 'break' } : node,
  )
}

/** 深度优先遍历 mdast，对所有 tableCell 节点执行转换 */
function convertCellBrTagsInTree(node: MdastNodeLike): void {
  if (node.type === 'tableCell') convertCellBrTags(node)
  node.children?.forEach(convertCellBrTagsInTree)
}

/**
 * 格内 `<br>` 标签还原为 hardbreak 的 remark 转换（裸 attacher，导出供单测）。
 *
 * milkdown 解析路径为 processor.runSync(parse(md))，remark transformer 会执行；
 * 序列化路径直接 stringify 不执行 transformer（格内 break 由 handler 处理）。
 *
 * @returns unified transformer，原地修改 mdast 树
 */
export const tableCellBrRemark: Plugin<[], Root> = function tableCellBrRemark() {
  return (tree) => convertCellBrTagsInTree(tree as MdastNodeLike)
}

/**
 * Milkdown 包装：注册位置必须早于 commonmark
 * （editor-core 装配处有顺序注释）。
 */
export const tableHardbreakPlugin = $remark('tmdTableHardbreak', () => tableCellBrRemark)
