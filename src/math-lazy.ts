/**
 * KaTeX 公式插件（@milkdown/plugin-math 的 vendor 版，katex 懒加载）。
 *
 * 为什么 vendor：katex（压缩后约 272KB）不能进主窗口启动包，而原包把
 * katex.render 写死在两个 schema 的 toDOM 里（静态 import katex），无法
 * 按需引入。本模块与其逐行等价的差异只有一处——toDOM 不再渲染公式，改为
 * 输出结构化 DOM（data-type / data-value / TeX 原文兜底显示）；公式显示由
 * 下方 $view NodeView 承担：katex 模块动态 import 懒加载，就绪前显示 TeX
 * 原文，就绪后 katex.render 补渲（失败回落 TeX 显示，绝不上屏裸错误）。
 *
 * 往返安全性：parseDOM 只读 data-value、toMarkdown 只读节点文本/attrs、
 * 剪贴板序列化走 toDOM——全部与 katex 是否在场无关。schema 定义、两条输入
 * 规则与 @milkdown/plugin-math@7.5.9 保持逐行等价（正则/顺序/参数不动）。
 * remark-math 是原包依赖，vendored 后由本模块直接依赖。
 *
 * @author chiangyang
 */
import { $inputRule, $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import { expectDomTypeError } from '@milkdown/kit/exception'
import { Fragment, type Node as ProseNode, type Schema } from '@milkdown/kit/prose/model'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { nodeRule } from '@milkdown/kit/prose'
import remarkMath from 'remark-math'

const remarkMathPlugin = $remark('remarkMath', () => remarkMath)

const mathInlineSchema = $nodeSchema('math_inline', () => ({
  group: 'inline',
  content: 'text*',
  inline: true,
  atom: true,
  parseDOM: [
    {
      tag: 'span[data-type="math_inline"]',
      getContent: (dom: globalThis.Node, schema: Schema) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom)
        return Fragment.from(schema.text(dom.dataset.value ?? ''))
      },
    },
  ],
  toDOM: (node: ProseNode) => {
    const tex = node.textContent
    const dom = document.createElement('span')
    dom.dataset.type = 'math_inline'
    dom.dataset.value = tex
    // katex 渲染由 NodeView 懒加载承担；此处只输出 TeX 原文兜底（剪贴板
    // 序列化也走这里，data-value 是 parseDOM 的唯一解析通道）
    dom.textContent = tex
    return dom
  },
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'inlineMath',
    runner: (state, node, type) => {
      state.openNode(type).addText(String(node.value ?? '')).closeNode()
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.textContent)
    },
  },
}))

const mathBlockSchema = $nodeSchema('math_block', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  atom: true,
  isolating: true,
  attrs: {
    value: {
      default: '',
    },
  },
  parseDOM: [
    {
      tag: 'div[data-type="math_block"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    },
  ],
  toDOM: (node: ProseNode) => {
    const tex = String(node.attrs.value)
    const dom = document.createElement('div')
    dom.dataset.type = 'math_block'
    dom.dataset.value = tex
    dom.textContent = tex
    return dom
  },
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value ?? '' })
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, String(node.attrs.value))
    },
  },
}))

const mathBlockInputRule = $inputRule((ctx) =>
  new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start)
    return $start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), mathBlockSchema.type(ctx))
      ? state.tr.delete(start, end).setBlockType(start, start, mathBlockSchema.type(ctx))
      : null
  }),
)

const mathInlineInputRule = $inputRule((ctx) =>
  nodeRule(/(?:\$)([^$]+)(?:\$)$/, mathInlineSchema.type(ctx), {
    beforeDispatch: ({ tr, match, start }) => {
      tr.insertText(match[1] ?? '', start + 1)
    },
  }),
)

// ---------- katex 懒加载渲染 ----------

let katexModule: Promise<typeof import('katex')> | null = null

function loadKatex(): Promise<typeof import('katex')> {
  katexModule ??= import('katex').catch((err: unknown) => {
    katexModule = null
    throw err
  })
  return katexModule
}

/** 每个 dom 一个渲染序号：katex 补渲到达时丢弃过期请求（update 可能先到） */
const renderTokens = new WeakMap<HTMLElement, number>()

/**
 * 把 TeX 渲染进 dom：katex 就绪前显示原文兜底，就绪后 katex.render 补渲。
 * 参数与原 toDOM 相同（无选项——app 从未注入 katexOptionsCtx）。
 */
function renderMathInto(dom: HTMLElement, tex: string): void {
  const seq = (renderTokens.get(dom) ?? 0) + 1
  renderTokens.set(dom, seq)
  dom.textContent = tex
  void loadKatex()
    .then((k) => {
      if (renderTokens.get(dom) !== seq) return
      dom.textContent = ''
      k.default.render(tex, dom)
    })
    .catch((err: unknown) => {
      // 模块装载近乎不可能失败（嵌入式资产）；兜底保留 TeX 原文显示
      console.error('[tmd] katex 模块加载失败', err)
    })
}

const mathInlineView = $view(mathInlineSchema.node, () => (node: ProseNode) => {
  const dom = document.createElement('span')
  dom.dataset.type = 'math_inline'
  const apply = (tex: string) => {
    dom.dataset.value = tex
    renderMathInto(dom, tex)
  }
  apply(node.textContent)
  return {
    dom,
    update(updated: ProseNode) {
      if (updated.type !== node.type) return false
      apply(updated.textContent)
      return true
    },
    ignoreMutation: () => true,
    stopEvent: () => false,
  }
})

const mathBlockView = $view(mathBlockSchema.node, () => (node: ProseNode) => {
  const dom = document.createElement('div')
  dom.dataset.type = 'math_block'
  const apply = (tex: string) => {
    dom.dataset.value = tex
    renderMathInto(dom, tex)
  }
  apply(String(node.attrs.value))
  return {
    dom,
    update(updated: ProseNode) {
      if (updated.type !== node.type) return false
      apply(String(updated.attrs.value))
      return true
    },
    ignoreMutation: () => true,
    stopEvent: () => false,
  }
})

export const mathLazyPlugins = [
  remarkMathPlugin,
  mathInlineSchema,
  mathBlockSchema,
  mathBlockInputRule,
  mathInlineInputRule,
  mathInlineView,
  mathBlockView,
].flat()
