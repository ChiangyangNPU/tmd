/**
 * 序列化补丁：恢复文本转义（修复表格单元格内字面 `|` 不被转义的问题）。
 *
 * 根因：milkdown core 自带的 stringify `text` handler 有个早退捷径——
 *   若文本不含 `*` `_` `\` 且以空白结尾，则 `return value` 原样输出，跳过
 *   全部转义（core 内 `remarkHandlers.text`）。于是「含 `|` 且末尾有空格」的
 *   表格单元格内容会输出裸 `|`，该行单元格数与分隔行不再匹配，重新解析时
 *   整张表退化为纯文本（数据丢失）。
 *   实测对照（单元格内容 `|2x2| `）：
 *     原版 → `| |2x2|  | c |`（未转义）；补丁后 → `| \|2x2\|  | c |`（正确）。
 *
 * 修复：用官方扩展点 `remarkStringifyOptionsCtx` 覆盖 `text` handler，去掉早退
 * 捷径、恒定走 `state.safe()`（`encode: []` 保持 milkdown 原设定：命中字符一律
 * 反斜杠转义）。`mdast-util-to-markdown` 的 safe() 在无命中时原样返回，因此
 * 普通文本不受影响；只有「含需转义标点且以空白结尾」的文本才会多出反斜杠。
 *
 * 时机：`.config()` 回调在 `init` 插件读取该选项之前执行（init 的 runner 先
 * `await ctx.waitTimers([ConfigReady])` 再 `ctx.get(remarkStringifyOptionsCtx)`），
 * 所以在 config 里覆盖是生效且受支持的。
 *
 * @author chiangyang
 */
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { $remark } from '@milkdown/kit/utils'
import type { Root } from 'mdast'
import type { Plugin } from 'unified'

/** safe() 的最小结构类型（避免依赖传递安装的 mdast-util-to-markdown 类型） */
interface SafeStateLike {
  safe(value: string, config: Record<string, unknown>): string
}

/** 文本节点（只用到 value） */
interface TextNodeLike {
  value: string
}

/**
 * 恒定走 safe() 的文本序列化：等价于 milkdown 原 handler，但去掉
 * 「末尾空白即原样输出」的早退捷径——该捷径正是 `|` 漏转义的来源。
 */
export function safeTextHandler(
  node: TextNodeLike,
  _parent: unknown,
  state: SafeStateLike,
  info: Record<string, unknown>,
): string {
  return state.safe(node.value, { ...info, encode: [] })
}

/** 覆盖 stringify 的 text handler（editor-core 的 config 装配中调用） */
export function patchTextEscaping(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (prev) => {
    const options = prev as { handlers?: Record<string, unknown> } & Record<string, unknown>
    // 结构类型与 mdast 内部 State/Handle 类型不重叠（本模块刻意不依赖
    // mdast-util-to-markdown 的类型），故经 unknown 收敛
    return {
      ...options,
      handlers: { ...options.handlers, text: safeTextHandler },
    } as unknown as typeof prev
  })
}

// ---------------------------------------------------------------------------
// 修复二：取消「普通段落行首 | 」的保守反斜杠转义
// ---------------------------------------------------------------------------

/** mdast-util-to-markdown 扩展中 unsafe 规则的最小结构 */
interface UnsafeRuleLike {
  atBreak?: boolean
  character?: string
}

/** toMarkdown 扩展的最小结构（gfm 顶层扩展只包一层嵌套 extensions 数组） */
interface ToMarkdownExtensionLike {
  unsafe?: UnsafeRuleLike[]
  extensions?: ToMarkdownExtensionLike[]
}

/**
 * 递归删除扩展链上「行首管道符」的保守转义规则。
 * gfm 预设把 mdast-util-gfm-table 的规则注册在嵌套 extensions 中
 * （顶层扩展只有一层 extensions 包装），故必须递归处理。
 */
function removePipeBreakRules(extensions: ToMarkdownExtensionLike[]): void {
  for (const ext of extensions) {
    if (ext.unsafe) {
      // gfm 扩展链上 atBreak + `|` 仅此一条：
      // { atBreak: true, character: '|', after: '[\t :-]' }（\t 为真实制表符）
      ext.unsafe = ext.unsafe.filter((rule) => !(rule.atBreak === true && rule.character === '|'))
    }
    if (ext.extensions) removePipeBreakRules(ext.extensions)
  }
}

/**
 * 裸 unified attacher：移除 gfm-table 的行首管道符保守转义（导出供单测往返）。
 *
 * 现象：段落文本 `| 55 | 55 |`（单行不构成 GFM 表格）每次序列化都变成
 * `\| 55 | 55 |`，切源码模式/存盘后源码被反斜杠污染，所见即所得里接着
 * 敲分隔行也拼不成表格（行首已是转义管道符）。
 *
 * 根因：mdast-util-gfm-table 注册 unsafe 规则
 * `{ atBreak: true, character: '|', after: '[\t :-]' }`，让换行后行首的
 * 「| + 空白/冒号/短横」一律转义，以防下一行恰好是分隔行时意外成表。
 *
 * 为何可安全移除：该防御针对的歧义结构在 mdast 中不可能存在——
 * 「管道行 + 紧邻分隔行」在 parse 阶段就被整体解析为 table 节点；能以
 * paragraph 存在的管道行，与相邻块之间序列化时必有空行（to-markdown
 * 默认块间 join 输出空行），重解析时空行阻断成表。blockquote / list
 * item 内同理：能成表的早已是 table 节点。多组 parse→stringify 往返
 * 验证：正常表格不变；表格单元格内的字面 `|` 由另一条
 * `{ character: '|', inConstruct: 'tableCell' }` 规则负责转义，不受影响
 * （db54686 的修复保持有效）。
 *
 * 实现：unsafe 只支持追加（configure 对 unsafe 数组做拼接），无法经
 * remarkStringifyOptionsCtx 覆盖删除，只能在 gfm attacher 之后直接改写
 * 其注册的扩展对象；compiler 在 process 时才读取 toMarkdownExtensions，
 * 故 attacher 阶段 mutate 生效。
 *
 * @author chiangyang
 */
export const stripPipeBreakEscaping: Plugin<[], Root> = function () {
  // vfile Data 类型只声明已知字段，toMarkdownExtensions 经字符串键动态读写
  const data = this.data() as Record<string, unknown>
  removePipeBreakRules((data.toMarkdownExtensions as ToMarkdownExtensionLike[] | undefined) ?? [])
}

/**
 * Milkdown 包装：必须晚于 gfm 预设注册——attacher 按注册顺序执行，
 * 执行时 gfm-table 的扩展须已压入 toMarkdownExtensions。
 */
export const pipeBreakEscapingRemark = $remark('tmdStripPipeBreak', () => stripPipeBreakEscaping)
