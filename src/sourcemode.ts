/**
 * 源码模式：CodeMirror 6 整篇源码编辑
 *
 * 进出模式时与所见即所得编辑器交换 markdown 全文；分屏时既可作为可编辑侧，
 * 也可作为只读跟随侧——只读由创建时的 `EditorView.editable` facet 决定
 * （切换活动侧时重建实例即可，不引入 Compartment；语法高亮经 HighlightStyle
 * 引用 CSS 变量，主题切换同样无需重建）。
 *
 * @author chiangyang
 */
import { EditorView as CMView, basicSetup } from 'codemirror'
import { markdown as cmMarkdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { InlineContext, MarkdownExtension } from '@lezer/markdown'
import { Tag, tags as t } from '@lezer/highlight'

/** 双链着色 tag（独立定义，不与普通链接共用样式规则） */
const wikiTag = Tag.define()

/**
 * 双链行内解析扩展：[[目标]] / [[目标|别名]] / [[目标#标题]] 整体着色。
 *
 * 现状 cmMarkdown() 无参 = CommonMark base，不识别 [[..]]，双链会按普通
 * 文本着色。此扩展在行内单趟解析中识别双方括号到最近 "]]" 的区段（行内
 * 换行终止）；行内代码 span 由内置解析器先消费，内容天然免疫。行内公式
 * $..$ 在 CommonMark 词法层不存在，$[[a]]$ 内会着色（与 remark 侧同一
 * 已知限制）。
 */
const wikilinkExtension: MarkdownExtension = {
  defineNodes: [{ name: 'WikiLink', style: wikiTag }],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1
        const end = findWikiEnd(cx, pos + 2)
        if (end < 0) return -1
        cx.addElement(cx.elt('WikiLink', pos, end))
        return end
      },
    },
  ],
}

/** 从内容起点向后找 "]]"，行内换行终止；返回闭括号之后的位置 */
function findWikiEnd(cx: InlineContext, from: number): number {
  for (let i = from; i < cx.end - 1; i++) {
    const code = cx.char(i)
    if (code === 10 /* \n */) return -1
    if (code === 93 /* ] */ && cx.char(i + 1) === 93) return i + 2
  }
  return -1
}

/**
 * 源码模式语法高亮。
 *
 * 颜色全部引用应用主题的 CSS 变量，因此深浅模式与各主题预设（含液态玻璃、
 * 文件式主题、自定义 CSS 变量的覆盖）自动跟随，无需在主题切换时重建实例。
 *
 * basicSetup 内置的 defaultHighlightStyle 以 `{ fallback: true }` 注册——
 * 只在没有其他样式命中该标签时生效，本样式不带 fallback，天然优先覆盖；
 * 未在此列出的标签仍回落默认值。
 */
const sourceHighlightStyle = HighlightStyle.define([
  {
    tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
    color: 'var(--accent)',
    fontWeight: 'bold',
  },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  // 行内代码与围栏代码块
  { tag: t.monospace, color: 'var(--accent)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' },
  // 语法标记符（# * > - 等）与分隔线、转义符、front matter
  { tag: [t.processingInstruction, t.contentSeparator, t.escape, t.meta], color: 'var(--muted)' },
  // 围栏代码块的语言标识（```js）
  { tag: t.labelName, color: 'var(--muted)' },
  { tag: t.invalid, color: 'var(--error-fg)' },
  // 双链 [[..]]（与所见即所得侧 a.wikilink 同为 accent 色）
  { tag: wikiTag, color: 'var(--accent)' },
])

/**
 * 创建 CodeMirror 编辑器实例挂到 parent
 *
 * @param parent - 挂载容器
 * @param markdown - markdown 全文
 * @param editable - 是否可编辑（分屏的只读跟随侧传 false：文本仍可选中复制，但不能输入）
 * @param onDocChange - 文档变更回调（分屏时用于把改动同步给另一侧）
 * @returns CodeMirror 视图实例
 */
export function createSourceEditor(
  parent: HTMLElement,
  markdown: string,
  editable = true,
  onDocChange?: (markdown: string) => void,
): CMView {
  return new CMView({
    doc: markdown,
    extensions: [
      basicSetup,
      cmMarkdown({ extensions: [wikilinkExtension] }),
      syntaxHighlighting(sourceHighlightStyle),
      editable ? [] : CMView.editable.of(false),
      onDocChange
        ? CMView.updateListener.of((update) => {
            // 程序化替换（同步跟随）也会触发 docChanged，由调用方按同步标志过滤
            if (update.docChanged) onDocChange(update.state.doc.toString())
          })
        : [],
    ],
    parent,
  })
}
