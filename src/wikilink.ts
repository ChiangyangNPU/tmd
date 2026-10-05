/**
 * 双链语法插件：[[目标]]、[[目标|别名]]、[[目标#标题]]
 *
 * 解析与序列化采用与 mark-ext.ts 相同的自研 $remark 模式（无现成 remark
 * wikilink 扩展可同时满足 parse/stringify/PM 三侧，且语法足够简单）：
 * 1. mdast transform（纯函数 convertWikiLinks，导出供单测）：text 节点内
 *    切分 [[...]] 产出自定义 wikilink 节点；行内代码是 inlineCode 原子节点
 *    天然免疫。行内公式 $...$ 在 remark 层仍是 text（已知限制，与 mark-ext
 *    的围栏守卫取舍一致：$[[a]]$ 内的双链会被切分）。
 * 2. $remark attacher：parse 挂 transform；stringify 经 toMarkdownExtensions
 *    注册 handler 无损输出（别名/标题锚统一规范化顺序 目标#标题|别名）。
 * 3. $nodeSchema 行内原子节点（结构同 gfm footnote_reference）：attrs
 *    target/alias/heading；parseDOM 接应用内复制粘贴的 a.wikilink。
 * 4. $inputRule：输入 ]] 即时转为原子节点（复用 mark-ext 的未闭合围栏守卫
 *    inUnclosedSpan，行内代码/公式内不激活）。
 * 5. $prose 插件两个：handleClick 点击跟随（解析与打开经 setWikilinkContext
 *    注入，main.ts 装配）；未解析装饰——目标在当前索引中不存在时给节点加
 *    .wikilink-unresolved 类（索引刷新经 notifyWikilinkIndexChanged 触发
 *    重算，装饰按 (doc, 版本号) 记忆避免每次绘制全树遍历）。
 *
 * 已知边界：
 * - target 中的 | 与 # 是结构符不可转义（含此类字面量的文件名无法用双链
 *   引用，极少见）；
 * - [[ 内外空白在序列化时规范化（[[ 目标 ]] → [[目标]]），不追求字节级原样；
 * - 别名/标题里再出现 | / # 的切分规则：第一个 | 切别名，剩余部分里第一个
 *   # 切标题（与 Obsidian 的书写习惯一致）。
 *
 * @author chiangyang
 */
import type { Root } from 'mdast'
import type { Plugin as UnifiedPlugin } from 'unified'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule, $nodeSchema, $prose, $remark } from '@milkdown/kit/utils'
import { expectDomTypeError } from '@milkdown/kit/exception'
import { inUnclosedSpan } from './mark-ext'

// ---------------------------------------------------------------------------
// 1. mdast transform（纯函数层，导出供单测）
// ---------------------------------------------------------------------------

/** 内部最小 mdast 节点结构（与 mark-ext.ts 同风格） */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  target?: string
  alias?: string
  heading?: string
}

/** wikilink 三段语义：目标文件（可含相对路径）、显示别名、目标内标题锚 */
export interface WikiParts {
  target: string
  alias: string
  heading: string
}

/**
 * 解析 [[...]] 内部文本（不含双方括号）：第一个 | 切别名，
 * | 之前的部分里第一个 # 切标题；各段 trim。导出供单测。
 */
export function parseWikiInner(inner: string): WikiParts {
  const pipe = inner.indexOf('|')
  const main = pipe === -1 ? inner : inner.slice(0, pipe)
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
  const hash = main.indexOf('#')
  const target = (hash === -1 ? main : main.slice(0, hash)).trim()
  const heading = hash === -1 ? '' : main.slice(hash + 1).trim()
  return { target, alias, heading }
}

/** text 值内的 wikilink 匹配：内容不允许出现 [ ] 与换行 */
const WIKI_TEXT_RE = /\[\[([^[\\\]\n]+)\]\]/g

/** 切分中间态 */
export type WikiSeg =
  { kind: 'text'; value: string } | { kind: 'wiki'; target: string; alias: string; heading: string }

/**
 * 把一个 text 值切分为「文本/wikilink」段序列。
 * 内容为空白的 [[]] / [[ ]] 不成节点，保持字面文本。
 */
export function parseWikiText(value: string): WikiSeg[] {
  const out: WikiSeg[] = []
  let last = 0
  for (const m of value.matchAll(WIKI_TEXT_RE)) {
    const index = m.index ?? 0
    const parts = parseWikiInner(m[1])
    if (!parts.target && !parts.heading) continue
    if (index > last) out.push({ kind: 'text', value: value.slice(last, index) })
    out.push({ kind: 'wiki', ...parts })
    last = index + m[0].length
  }
  if (last < value.length) out.push({ kind: 'text', value: value.slice(last) })
  return out
}

/**
 * 递归遍历 mdast，把含 [[...]] 语法的 text 节点就地替换为
 * 「text + wikilink 节点」序列；wikilink 节点内部不再递归（纯文本构成）。
 */
export function convertWikiLinks(node: MdNode): void {
  if (!node.children) return
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'text' && child.value !== undefined && child.value.includes('[[')) {
      const parsed = parseWikiText(child.value)
      const changed = parsed.length !== 1 || parsed[0].kind !== 'text'
      if (changed) {
        const nodes = parsed.map((seg): MdNode =>
          seg.kind === 'text'
            ? { type: 'text', value: seg.value }
            : { type: 'wikilink', target: seg.target, alias: seg.alias, heading: seg.heading },
        )
        children.splice(i, 1, ...nodes)
        i += nodes.length - 1
        continue
      }
    }
    convertWikiLinks(child)
  }
}

// ---------------------------------------------------------------------------
// 2. $remark attacher：parse transform + stringify handler
// ---------------------------------------------------------------------------

const wikiPlugin: UnifiedPlugin<[], Root> = function () {
  const data = this.data() as Record<string, unknown>
  const add = (field: string, value: unknown) => {
    const list = data[field] as unknown[] | undefined
    if (list) list.push(value)
    else data[field] = [value]
  }
  add('toMarkdownExtensions', {
    handlers: {
      wikilink: (node: unknown) => {
        const { target, alias, heading } = node as WikiParts & { type: string }
        const inner = `${target}${heading ? `#${heading}` : ''}${alias ? `|${alias}` : ''}`
        return `[[${inner}]]`
      },
    },
  })
  return (tree) => convertWikiLinks(tree as unknown as MdNode)
}

/** 导出裸 unified 插件供单测做 parse→stringify 往返（$remark 仅做 Milkdown 包装） */
export { wikiPlugin }

const wikiRemark = $remark('tmdWikilink', () => wikiPlugin)

// ---------------------------------------------------------------------------
// 3. 节点 schema：行内原子节点（结构同 gfm footnote_reference）
// ---------------------------------------------------------------------------

const wikilinkSchema = $nodeSchema('wikilink', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    target: { default: '' },
    alias: { default: '' },
    heading: { default: '' },
  },
  parseDOM: [
    {
      tag: 'a.wikilink',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom)
        return {
          target: dom.dataset.target ?? '',
          alias: dom.dataset.alias ?? '',
          heading: dom.dataset.heading ?? '',
        }
      },
    },
  ],
  toDOM: (node) => {
    const { target, alias, heading } = node.attrs as WikiParts
    return [
      'a',
      {
        class: 'wikilink',
        'data-target': target,
        'data-alias': alias,
        'data-heading': heading,
      },
      alias || target,
    ]
  },
  parseMarkdown: {
    match: ({ type }) => type === 'wikilink',
    runner: (state, node, type) => {
      state.addNode(type, {
        target: (node as MdNode).target ?? '',
        alias: (node as MdNode).alias ?? '',
        heading: (node as MdNode).heading ?? '',
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikilink',
    runner: (state, node) => {
      state.addNode('wikilink', undefined, undefined, {
        target: node.attrs.target,
        alias: node.attrs.alias,
        heading: node.attrs.heading,
      })
    },
  },
}))

// ---------------------------------------------------------------------------
// 4. 输入规则：输入 ]] 即时转为原子节点
// ---------------------------------------------------------------------------

/** 输入规则正则（导出供单测）：[[内部]] 以 ] 键入收尾触发 */
export const WIKI_INPUT_RE = /\[\[([^[\\\]\n]+)\]\]$/

const wikilinkInputRule = $inputRule(
  (ctx) =>
    new InputRule(WIKI_INPUT_RE, (state, match, start, end) => {
      const $end = state.doc.resolve(end)
      // 输入过程中围栏尚未成节点，段落内均为纯文本
      const full = $end.parent.textBetween(0, $end.parent.content.size, '\n', '\ufffc')
      const offset = end - $end.start()
      if (inUnclosedSpan(full.slice(0, offset))) return null
      const { target, alias, heading } = parseWikiInner(match[1])
      if (!target && !heading) return null
      return state.tr.replaceWith(
        start,
        end,
        wikilinkSchema.type(ctx).create({ target, alias, heading }),
      )
    }),
)

// ---------------------------------------------------------------------------
// 5. 解析上下文 + 点击跟随 + 未解析装饰
// ---------------------------------------------------------------------------

/** 解析结果：ok 命中；ambiguous 多个同名；missing 未找到；pending 索引未就绪 */
export type WikiResolution =
  | { kind: 'ok'; path: string }
  | { kind: 'ambiguous'; paths: string[] }
  | { kind: 'missing' }
  | { kind: 'pending' }

/** 解析与跳转上下文（main.ts 装配注入；渲染层默认 pending 不着色不响应） */
export interface WikilinkContext {
  /** 同步解析（基于渲染层缓存的索引；target 可为相对路径/文件名，含 .md 与否均可） */
  resolve(target: string): WikiResolution
  /** 点击跟随：打开目标文件并处理标题锚/未解析提示 */
  follow(target: string, heading: string, resolution: WikiResolution): void
}

let wikilinkContext: WikilinkContext = {
  resolve: () => ({ kind: 'pending' }),
  follow: () => {},
}

/** main.ts 启动时注入解析与跳转上下文 */
export function setWikilinkContext(next: WikilinkContext): void {
  wikilinkContext = next
}

/** 点击跟随插件：点击 wikilink 原子节点即跳转（无需按修饰键） */
const wikilinkClick = $prose(
  () =>
    new Plugin({
      props: {
        handleClick: (view: EditorView, pos: number, event: MouseEvent): boolean => {
          // 原子节点：点击落点在节点起止之间，nodeAfter/nodeBefore 兜住两种落点
          const $pos = view.state.doc.resolve(pos)
          const node: ProseNode | null | undefined =
            $pos.nodeAfter?.type.name === 'wikilink'
              ? $pos.nodeAfter
              : $pos.nodeBefore?.type.name === 'wikilink'
                ? $pos.nodeBefore
                : null
          if (!node) return false
          const { target, heading } = node.attrs as WikiParts
          const resolution = wikilinkContext.resolve(target)
          if (resolution.kind === 'pending') return false
          event.preventDefault()
          wikilinkContext.follow(target, heading, resolution)
          return true
        },
      },
    }),
)

/** 装饰插件 key：索引刷新时经 setMeta 触发装饰重算（state 值即版本号） */
const wikiDecoKey = new PluginKey<number>('tmd-wikilink-index')

/** 已注册的编辑器视图（notify 时派发空事务触发装饰重算） */
let activeView: EditorView | null = null

const wikilinkDecorations = $prose(() => {
  // 装饰记忆：按 (当前文档, 索引版本) 缓存，避免每次视图绘制全树遍历
  let memoDoc: ProseNode | null = null
  let memoVersion = -1
  let memoDecos: DecorationSet | null = null
  return new Plugin({
    key: wikiDecoKey,
    view: (view) => {
      activeView = view
      return {
        destroy: () => {
          if (activeView === view) activeView = null
        },
      }
    },
    state: {
      init: () => 0,
      apply: (tr, value) => {
        if (tr.getMeta(wikiDecoKey)) return value + 1
        return value
      },
    },
    props: {
      decorations: (state) => {
        const version = wikiDecoKey.getState(state) ?? 0
        if (memoDoc === state.doc && memoVersion === version && memoDecos) {
          return memoDecos
        }
        const decos: Decoration[] = []
        state.doc.descendants((node: ProseNode, pos: number) => {
          if (node.type.name !== 'wikilink') return
          const resolution = wikilinkContext.resolve(node.attrs.target as string)
          if (resolution.kind === 'missing') {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wikilink-unresolved' }))
          }
        })
        memoDoc = state.doc
        memoVersion = version
        memoDecos = DecorationSet.create(state.doc, decos)
        return memoDecos
      },
    },
  })
})

/**
 * 索引变化后调用：触发未解析装饰重算（索引层在扫描完成/失效时调用）。
 * 无编辑器视图时静默（面板尚不存在）。
 */
export function notifyWikilinkIndexChanged(): void {
  if (!activeView) return
  activeView.dispatch(activeView.state.tr.setMeta(wikiDecoKey, true))
}

/** 全部双链插件，统一给编辑器 .use() */
export const wikilinkPlugins = [
  wikiRemark,
  wikilinkSchema,
  wikilinkInputRule,
  wikilinkClick,
  wikilinkDecorations,
].flat()
