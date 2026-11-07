/**
 * 原生 HTML 安全渲染（块级）。
 *
 * Typora 兼容点：Markdown 中独立成块的 `<details>` / `<div>` / `<table>` 等
 * HTML 会被渲染；本模块用 remark 转换把根/引用/列表中的 `html` 节点换成
 * 原子块 `html_block`，NodeView 用白名单 sanitizer 渲染，源码原样保留并可
 * 在源码模式编辑。行内 HTML（`<kbd>` 等）仍按文本显示——标签对通常被
 * remark 拆成多个 html 节点，逐段渲染会破坏嵌套；按块级支持是安全且可
 * 字节级往返的取舍。
 *
 * sanitizer（sanitize-html，压缩后约 550KB）在 ./html-sanitize 经动态 import
 * 懒加载：文档模型全程存原始 HTML，清洗只影响 NodeView 显示层，因此模块
 * 未就绪时先显示占位、就绪后补渲，parse/serialize 往返不受影响。sanitizer
 * 本体不进启动包。
 *
 * @author chiangyang
 */
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** html-sanitize 模块（sanitize-html）的单例加载器；失败清缓存允许重试 */
let sanitizeModule: Promise<typeof import('./html-sanitize')> | null = null

function loadSanitizeModule(): Promise<typeof import('./html-sanitize')> {
  sanitizeModule ??= import('./html-sanitize').catch((err: unknown) => {
    sanitizeModule = null
    throw err
  })
  return sanitizeModule
}

type MdNode = {
  type: string
  value?: string | null
  children?: MdNode[]
  position?: unknown
}


/** 可承载块级 HTML 的 mdast 容器（段落/标题里的 html 属于行内，保持原样） */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/**
 * 把块级容器中的 html 节点换成自定义 html_block 节点（保留原始 value）。
 * 由 remark 插件在 TOC 转换之后调用，避免吞掉 `<!-- TOC -->` 标记。
 *
 * Milkdown 的 remarkHtmlTransformer 会先把块级 html 节点包成
 * `paragraph > html`（见 preset-commonmark），所以这里同时识别「仅含一个
 * html 子节点的段落」；普通段落里的行内 html 不转换。
 *
 * 替换节点必须保留原 position：后续管线（frontmatter 的 extractRaw 等）
 * 依赖兄弟节点的 position 做源码切片，缺失会被回退成「切到文末」，
 * 把整篇文档吞进 front matter 的 value（回归：保存时全文成倍重复）。
 */
export function convertHtmlBlocks(node: MdNode): void {
  if (!node.children) return
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    const wrappedHtml =
      child.type === 'paragraph' &&
      child.children?.length === 1 &&
      child.children[0]?.type === 'html'
    if (BLOCK_PARENTS.has(node.type) && (child.type === 'html' || wrappedHtml)) {
      const raw = child.type === 'html' ? child.value : child.children?.[0]?.value
      node.children[i] = { type: 'html_block', value: raw ?? '', position: child.position }
      continue
    }
    convertHtmlBlocks(child)
  }
}

const rawHtmlRemark = $remark('rawHtmlRemark', () => () => (tree: unknown) => {
  convertHtmlBlocks(tree as MdNode)
})

const rawHtmlSchema = $nodeSchema('html_block', () => ({
  group: 'block',
  atom: true,
  defining: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-type="html-block"]',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    },
  ],
  toDOM: (node: ProseNode) => [
    'div',
    {
      'data-type': 'html-block',
      'data-value': node.attrs.value,
      class: 'raw-html-block',
    },
  ],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'html_block',
    runner: (state, node, type) => state.addNode(type, { value: node.value ?? '' }),
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === 'html_block',
    runner: (state, node) => state.addNode('html', undefined, String(node.attrs.value)),
  },
}))

const rawHtmlView = $view(rawHtmlSchema.node, () => (node: ProseNode) => {
  const dom = document.createElement('div')
  dom.className = 'raw-html-block'
  dom.dataset.type = 'html-block'
  dom.setAttribute('contenteditable', 'false')
  // sanitizer 懒加载：就绪前显示占位，就绪后按序号补渲（视图内防竞态——
  // update 可能先于上一次异步补渲到达，过期结果必须丢弃）
  let renderSeq = 0
  const render = (value: string) => {
    const seq = ++renderSeq
    const apply = (safe: string) => {
      if (seq !== renderSeq) return
      if (safe.trim()) {
        dom.innerHTML = safe
      } else {
        // 纯注释 / 被清洗掉的标签：留一个可见占位，避免出现无法感知的空块
        dom.innerHTML = '<span class="raw-html-empty">HTML</span>'
      }
    }
    void loadSanitizeModule()
      .then((m) => apply(m.sanitizeRawHtml(value)))
      .catch((err: unknown) => {
        // 模块装载近乎不可能失败（嵌入式资产）；兜底占位且绝不裸插原始 HTML
        console.error('[tmd] sanitizer 模块加载失败', err)
        apply('')
      })
  }
  render(node.attrs.value)
  return {
    dom,
    update(updated: ProseNode) {
      if (updated.type !== node.type) return false
      render(updated.attrs.value)
      return true
    },
    ignoreMutation: () => true,
    stopEvent: () => false,
  }
})

export const rawHtmlPlugins = [rawHtmlRemark, rawHtmlSchema, rawHtmlView].flat()
