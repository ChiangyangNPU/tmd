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
import { tags as t } from '@lezer/highlight'

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
      cmMarkdown(),
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
