/**
 * 扩展行内标记插件：==高亮==、^上标^、~下标~
 *
 * 语法（解析时三种成对写法均支持）：
 *   ==高亮内容==          → <mark>
 *   x^2^ 或 x^{2}         → <sup>
 *   H~2~O 或 H_{2}O       → <sub>
 * 序列化统一输出 Pandoc 单符号风格（^x^ / ~x~），花括号写法仅作为输入兼容。
 *
 * 为什么自研 transform 而非引入 remark 插件：
 * - remark-supersub 五年未更新、只有 parse 方向、不支持嵌套节点；
 * - 花括号扩展包周下载量极低；而本需求只需在 mdast text 节点内做成对切分，
 *   逻辑简单可控，且与 toc.ts / mermaid.ts 的 $remark transform 模式一致。
 *
 * 组成：
 * 1. mdast transform（纯函数 convertInlineExts，导出供单测）：
 *    切分 text 节点中的成对语法；行内代码/公式/链接 URL 均非 text 子节点，
 *    天然免疫。另需处理 remark-gfm 的 singleTilde 默认行为：~x~ 会被词法层
 *    解析成 delete，依据节点 position 回溯源码定界符，把「单波浪」delete
 *    纠正为 subscript（~~双波浪~~ 保持删除线）。
 * 2. $remark attacher：注册 toMarkdown handlers（== / ^ / ~ 输出）+ 挂 transform。
 *    机制与 remark-gfm 相同：this.data('toMarkdownExtensions') 注入序列化扩展。
 * 3. 三个 $markSchema：parseMarkdown 接自定义 mdast 节点，parseDOM 接粘贴的
 *    <mark>/<sup>/<sub> HTML，toMarkdown 回写自定义节点。
 * 4. $inputRule：所见即所得中输入闭合分隔符即时成标（与粗体 ** 输入体验一致）。
 *    规则带「未闭合围栏」守卫：匹配点前方存在奇数个未转义反引号/美元符且后方
 *    仍有同字符时不应用（`m^2^`、$a^{b}$ 在围栏闭合前输入的分隔符保持字面，
 *    否则分隔符先被吃掉，行内代码/公式闭合时内容无法还原）。
 * 5. 脚注输入规则（gfm preset 仅含 schema 与 remark 解析，不含输入规则，此处补齐）：
 *    行内 [^label] 输入 ] 即时转为脚注引用原子节点；新行输入 [^label]: 后跟
 *    空格把该段转为脚注定义节点（dl/dt/dd）。同样套用未闭合围栏守卫。
 *
 * 已知限制：
 * - 不支持跨节点配对（如 ==**粗体**==）与标记内部嵌套其他行内语法；
 * - 反斜杠转义 \^、\~ 不识别（text 节点已丢失反斜杠位置信息），需要字面量时
 *   请使用行内代码；\= 因 = 不是 CommonMark 可转义标点反而天然安全；
 * - ^ ^、~ ~ 配对内容不允许含空白（与 markdown-it-sup/sub 一致，降低口语化
 *   误配），花括号写法允许空格；
 * - 围栏守卫为启发式：同段存在单个未闭合 $（未转义）时一律抑制成标，
 *   货币文案可写 \\$5 规避；换取公式 $a^{b}$ 内容不被提前切分（切分不可恢复）。
 *
 * @author chiangyang
 */
import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import { $inputRule, $markSchema, $prose, $remark } from '@milkdown/kit/utils'
import { markRule } from '@milkdown/kit/prose'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { footnoteDefinitionSchema, footnoteReferenceSchema } from '@milkdown/kit/preset/gfm'
import { paragraphSchema } from '@milkdown/kit/preset/commonmark'

// ---------------------------------------------------------------------------
// 1. mdast transform（纯函数层，不依赖 Milkdown，便于单测）
// ---------------------------------------------------------------------------

/** 内部最小 mdast 节点结构（与 toc.ts/mermaid.ts 同风格，避免引入传递依赖类型） */
export interface ExtMdNode {
  type: string
  value?: string
  children?: ExtMdNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

type ExtName = 'highlight' | 'superscript' | 'subscript'

/** 切分中间态：普通文本段或已识别的扩展段 */
interface Seg {
  kind: 'text' | 'ext'
  value: string
  ext?: ExtName
}

/**
 * 按「开闭相同」的成对分隔符切分文本。
 * 分隔符个数为 0 或奇数（无法全部配对）时返回 null，整段保持原样。
 * 空内容（如 ====）不产生扩展节点，同样返回 null。
 * noWhitespace：单符号 ^ / ~ 使用（内容含空白不配对，降低口语化误配）；
 * == 高亮不受此限。
 */
function splitPaired(
  value: string,
  delim: string,
  ext: ExtName,
  noWhitespace = false,
): Seg[] | null {
  const parts = value.split(delim)
  if (parts.length === 1 || parts.length % 2 === 0) return null
  const segs: Seg[] = []
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    if (i % 2 === 1) {
      if (seg === '' || (noWhitespace && /\s/.test(seg))) return null
      segs.push({ kind: 'ext', value: seg, ext })
    } else if (seg !== '') {
      segs.push({ kind: 'text', value: seg })
    }
  }
  return segs
}

/**
 * 按「开括号不同、闭括号相同」的花括号语法切分（^{x} / _{x}）。
 * 内容不允许含花括号（不支持嵌套）且不能为空；无匹配返回 null。
 */
function splitBrace(value: string, open: '^{' | '_{', ext: ExtName): Seg[] | null {
  const re = open === '^{' ? /\^\{([^{}]+)\}/g : /_\{([^{}]+)\}/g
  if (!re.test(value)) return null
  re.lastIndex = 0
  const segs: Seg[] = []
  let last = 0
  for (const m of value.matchAll(re)) {
    const index = m.index ?? 0
    if (index > last) segs.push({ kind: 'text', value: value.slice(last, index) })
    segs.push({ kind: 'ext', value: m[1], ext })
    last = index + m[0].length
  }
  if (last < value.length) segs.push({ kind: 'text', value: value.slice(last) })
  return segs
}

/**
 * 把一个 text 节点值解析为「文本/扩展」子段序列。
 * 顺序：先花括号（无歧义），再单符号 ^、~，最后 ==；
 * 已识别的扩展段不再参与后续切分。
 */
export function parseInlineExts(value: string): ExtMdNode[] {
  let segs: Seg[] = [{ kind: 'text', value }]
  const rules: Array<(v: string) => Seg[] | null> = [
    (v) => splitBrace(v, '^{', 'superscript'),
    (v) => splitBrace(v, '_{', 'subscript'),
    (v) => splitPaired(v, '^', 'superscript', true),
    (v) => splitPaired(v, '~', 'subscript', true),
    (v) => splitPaired(v, '==', 'highlight'),
  ]
  for (const rule of rules) {
    const next: Seg[] = []
    for (const seg of segs) {
      if (seg.kind === 'ext') {
        next.push(seg)
        continue
      }
      next.push(...(rule(seg.value) ?? [seg]))
    }
    segs = next
  }
  return segs.map((seg) =>
    seg.kind === 'text'
      ? { type: 'text', value: seg.value }
      : { type: seg.ext as string, children: [{ type: 'text', value: seg.value }] },
  )
}

/** 拼接节点全部后代 text 值（用于判断单波浪内容是否含空白） */
function nodeText(node: ExtMdNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(nodeText).join('')
}

/**
 * 判断 delete 节点是否由「单波浪」~x~ 产生（remark-gfm 默认 singleTilde:true，
 * 词法层会把单波浪也解析成删除线）。依据节点 position 回溯原始 markdown：
 * 开闭定界符各恰为一个 ~ 即认定为下标；内容含空白则保守保持删除线。
 */
function isSingleTildeSub(node: ExtMdNode, source: string | undefined): boolean {
  if (!source || node.type !== 'delete') return false
  const s = node.position?.start.offset
  const e = node.position?.end.offset
  if (s === undefined || e === undefined || e - s < 3) return false
  if (source[s] !== '~' || source[s + 1] === '~') return false
  if (source[e - 1] !== '~' || source[e - 2] === '~') return false
  return !/\s/.test(nodeText(node))
}

/**
 * 递归遍历 mdast，把含成对扩展语法的 text 节点就地替换为
 * 「text + 扩展容器节点」序列。自定义扩展节点内部不再递归（其 children
 * 刚由纯文本构造）。
 *
 * source：原始 markdown 文本（VFile.value）。remark-gfm 默认把单波浪 ~x~
 * 也解析为 delete，这里依据 position 把「单波浪且内容无空白」的 delete
 * 纠正为 subscript；双波浪 ~~x~~ 保持删除线不动。
 */
export function convertInlineExts(node: ExtMdNode, source?: string): void {
  if (isSingleTildeSub(node, source)) node.type = 'subscript'
  if (!node.children) return
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'text' && child.value !== undefined && /[=^~_]/.test(child.value)) {
      const parsed = parseInlineExts(child.value)
      const changed = parsed.length !== 1 || parsed[0].type !== 'text'
      if (changed) {
        children.splice(i, 1, ...parsed)
        i += parsed.length - 1
        continue
      }
    }
    convertInlineExts(child, source)
  }
}

// ---------------------------------------------------------------------------
// 2. $remark attacher：toMarkdown handlers + transform
// ---------------------------------------------------------------------------

/** stringify handler 的最小 state 结构（仅声明用到的方法） */
interface StringifyState {
  enter: (name: string) => () => void
  containerPhrasing: (node: unknown, info: { before: string; after: string }) => string
}

/** 构造一个容器型行内节点的 stringify handler：分隔符包裹子内容 */
function wrapHandler(delim: string) {
  return (node: unknown, _parent: unknown, state: StringifyState): string => {
    const exit = state.enter('phrasing')
    const content = state.containerPhrasing(node, { before: delim[0], after: delim[0] })
    exit()
    return `${delim}${content}${delim}`
  }
}

/**
 * 统一的 remark attacher（unified Plugin）。
 * - parse 阶段：transform 把 text 切成自定义节点，再由下方 mark schema 承接；
 * - stringify 阶段：mark schema 的 toMarkdown 会产出自定义 mdast 节点，
 *   这里注册的 handlers 负责输出 == / ^ / ~ 分隔符（花括号输入也统一为单符号）。
 */
const inlineExtPlugin: Plugin<[], Root> = function () {
  // vfile Data 类型只声明已知字段，toMarkdownExtensions 经字符串键动态读写
  const data = this.data() as Record<string, unknown>
  const add = (field: string, value: unknown) => {
    const list = data[field] as unknown[] | undefined
    if (list) list.push(value)
    else data[field] = [value]
  }
  add('toMarkdownExtensions', {
    handlers: {
      highlight: wrapHandler('=='),
      superscript: wrapHandler('^'),
      subscript: wrapHandler('~'),
    },
  })
  return (tree: Root, file) =>
    convertInlineExts(tree as ExtMdNode, typeof file.value === 'string' ? file.value : undefined)
}

/** 导出裸 unified 插件供单测做 parse→stringify 往返（$remark 仅做 Milkdown 包装） */
export { inlineExtPlugin }

const inlineExtRemark = $remark('tmdInlineExt', () => inlineExtPlugin)

// ---------------------------------------------------------------------------
// 3. mark schema：highlight / superscript / subscript
// ---------------------------------------------------------------------------

/** 构造一个容器型行内 mark（结构同 gfm 的 strikethroughSchema） */
function defineExtMark(name: ExtName, tag: string) {
  return $markSchema(name, () => ({
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0] as [string, number],
    parseMarkdown: {
      match: (node) => node.type === name,
      runner: (state, node, markType) => {
        state.openMark(markType)
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === name,
      runner: (state, mark) => {
        state.withMark(mark, name)
      },
    },
  }))
}

const highlightSchema = defineExtMark('highlight', 'mark')
const superscriptSchema = defineExtMark('superscript', 'sup')
const subscriptSchema = defineExtMark('subscript', 'sub')

// ---------------------------------------------------------------------------
// 4. input rules：输入闭合分隔符即时成标
// ---------------------------------------------------------------------------

/**
 * 判断匹配点之前是否存在尚未闭合的行内代码（`）或行内公式（$）围栏：
 * 未转义的围栏字符为奇数个即视为在围栏内。不能要求「后方还有同字符」——
 * 输入规则在闭合定界符键入瞬间触发，此时围栏的闭合符（`/$）还没打出来。
 * 取舍：同段单个 $ 的货币文案（售价 $5，x^2^）会被保守抑制，用户可写
 * 转义 \\$5 规避；而公式内 ^{} 被错误切分后内容永久丢失，优先级更高。
 * 导出纯函数供单测。
 */
export function inUnclosedSpan(before: string): boolean {
  return ['`', '$'].some((ch) => {
    const escaped = new RegExp(`(?<!\\\\)\\${ch}`, 'g')
    return (before.match(escaped)?.length ?? 0) % 2 === 1
  })
}

type InputRuleHandler = (
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
) => Transaction | null

/**
 * 给 markRule 包一层未闭合围栏守卫。handler 是 InputRule 的公有可写属性。
 */
function guardedMarkRule(regexp: RegExp, markType: Parameters<typeof markRule>[1]): InputRule {
  // prosemirror-inputrules 的类型声明未公开 handler（运行时为公有可写属性）
  const rule = markRule(regexp, markType) as InputRule & { handler: InputRuleHandler }
  const inner = rule.handler
  rule.handler = (state, match, start, end) => {
    const $end = state.doc.resolve(end)
    // 输入过程中围栏尚未成节点，段落内均为纯文本；leafText 占位不会命中
    const full = $end.parent.textBetween(0, $end.parent.content.size, '\n', '￼')
    const offset = end - $end.start()
    if (inUnclosedSpan(full.slice(0, offset))) return null
    return inner(state, match, start, end)
  }
  return rule
}

/**
 * 单符号规则要点：
 * - (?<!delim) 负向后顾，避免 ~~删除线~~ 输入过程中被下标规则抢先（~x~ 的
 *   开波浪前若也是 ~，整段让给删除线规则）；
 * - 内容禁止空白与分隔符自身，降低口语化误配；
 * - == 高亮允许空格但不允许内含 =；花括号写法 ^{x} / _{x} 内容允许空格。
 */
const highlightInputRule = $inputRule((ctx) =>
  guardedMarkRule(/(?<!=)==([^=\n]+)==$/, highlightSchema.type(ctx)),
)
const supInputRule = $inputRule((ctx) =>
  guardedMarkRule(/(?<!\^)\^([^\s^]+)\^$/, superscriptSchema.type(ctx)),
)
const subInputRule = $inputRule((ctx) =>
  guardedMarkRule(/(?<!~)~([^\s~]+)~$/, subscriptSchema.type(ctx)),
)
const supBraceInputRule = $inputRule((ctx) =>
  guardedMarkRule(/\^\{([^{}\n]+)\}$/, superscriptSchema.type(ctx)),
)
const subBraceInputRule = $inputRule((ctx) =>
  guardedMarkRule(/_\{([^{}\n]+)\}$/, subscriptSchema.type(ctx)),
)

// ---------------------------------------------------------------------------
// 5. 脚注输入规则（gfm preset 只有 schema，输入路径在此补齐）
// ---------------------------------------------------------------------------

/**
 * 脚注引用正则：行内 [^label]，] 键入瞬间触发。
 * label 不允许空白与 ]；导出供单测。
 */
export const FOOTNOTE_REF_RE = /(\[\^)([^\s\]]+)(\])$/

/**
 * 脚注定义正则：新行输入 [^label]: 后跟空格触发。
 * 两种形态（行首锚定）：
 * - \ufffc 占位：正常输入流中 [^label] 已被引用规则转为脚注引用原子节点，
 *   InputRule 的 textBefore 用 \ufffc 表示原子节点，label 从节点 attrs 取；
 * - 字面 [^label]：粘贴纯文本后补冒号等场景，label 取 match[2]。
 * $ 锚要求光标处即段尾（handler 另有段尾守卫），已有正文的段落不会误转。
 * 导出供单测。
 */
export const FOOTNOTE_DEF_RE = /^(\ufffc|\[\^([^\s\]]+)\]):\s$/

/**
 * 脚注引用：[^label] 输入 ] 时替换为 footnote_reference 原子节点，
 * 其余文本原样保留。行内代码/公式内不激活（与扩展行内标记同一守卫）。
 */
const footnoteRefInputRule = $inputRule(
  (ctx) =>
    new InputRule(FOOTNOTE_REF_RE, (state, match, start, end): Transaction | null => {
      const $end = state.doc.resolve(end)
      const full = $end.parent.textBetween(0, $end.parent.content.size, '\n', '￼')
      const offset = end - $end.start()
      if (inUnclosedSpan(full.slice(0, offset))) return null
      return state.tr.replaceWith(
        start,
        end,
        footnoteReferenceSchema.type(ctx).create({ label: match[2] }),
      )
    }),
)

/**
 * 脚注定义：段落整段替换为 footnote_definition（dt 显示 label，dd 承载正文）。
 * 内部放一个空段落承接后续输入（content: block+ 要求至少一个子块）。
 */
const footnoteDefInputRule = $inputRule(
  (ctx) =>
    new InputRule(FOOTNOTE_DEF_RE, (state, match, start, end): Transaction | null => {
      const $start = state.doc.resolve(start)
      const $cursor = state.doc.resolve(end)
      // 光标须在段尾：防止回头补定义时吞掉行内光标之后的已有文本
      if ($cursor.parentOffset !== $cursor.parent.content.size) return null
      // 匹配须从段落内容起点开始（^ 锚定在超过匹配窗口的长段落里可能失效），
      // 从段中替换会切开段落节点留下空壳
      if ($start.parentOffset !== 0) return null
      // label 来源：占位形态取行首脚注引用节点的 attrs；字面形态取正则分组
      let label: string
      if (match[1] === '\ufffc') {
        const ref = $start.nodeAfter
        if (ref?.type.name !== 'footnote_reference') return null
        label = ref.attrs.label
      } else {
        label = match[2] ?? ''
      }
      // 替换范围为整个段落节点（before → after）：若只从内容起点替换到段尾，
      // 切分点左侧会残留空段落，序列化时多出 <br />
      const tr = state.tr.replaceWith(
        $start.before(),
        $start.after(),
        footnoteDefinitionSchema.type(ctx).create({ label }, paragraphSchema.type(ctx).create()),
      )
      // 光标送入 dd 内的空段落，紧接输入即为脚注正文
      return tr
        .setSelection(TextSelection.near(tr.doc.resolve($start.before() + 1), 1))
        .scrollIntoView()
    }),
)

/**
 * 脚注定义退出：dl 内最后一个块的段尾按 Enter → 在 dl 之后新建正文段落，
 * 光标随之移出（与 Typora 的脚注定义回车退出一致）。dl 内非段尾位置
 * Enter 返回 false 走默认分段，保留脚注体内多段落编辑能力。
 * 注意：commonmark 仅在 list_item 内绑定 Enter（dl 内不命中），
 * 本规则注册在其后即可生效。
 */
const footnoteDefExit = $prose(() =>
  keymap({
    Enter: (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
      const { $from } = state.selection
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name !== 'footnote_definition') continue
        const def = $from.node(d)
        // 光标须在定义的最后一个子块的段尾（after(d)-1 是 dl 自身闭合
        // token 的位置，须再扣除子块闭合 token，故改用语义化判断）
        if (def.lastChild !== $from.node($from.depth)) return false
        if ($from.parentOffset !== $from.parent.content.size) return false
        if (!dispatch) return true
        const pos = $from.after(d)
        const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create())
        dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1)).scrollIntoView())
        return true
      }
      return false
    },
  }),
)

/** 全部扩展行内标记插件，统一给编辑器 .use() */
export const markPlugins = [
  inlineExtRemark,
  highlightSchema,
  superscriptSchema,
  subscriptSchema,
  highlightInputRule,
  supInputRule,
  subInputRule,
  supBraceInputRule,
  subBraceInputRule,
  footnoteRefInputRule,
  footnoteDefInputRule,
  footnoteDefExit,
].flat()
