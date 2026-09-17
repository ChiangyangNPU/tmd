/**
 * 源码模式：CodeMirror 6 整篇源码编辑
 *
 * 进出模式时与所见即所得编辑器交换 markdown 全文；分屏时既可作为可编辑侧，
 * 也可作为只读跟随侧——只读由创建时的 `EditorView.editable` facet 决定
 * （切换活动侧时重建实例即可，不引入 Compartment / 额外依赖）。
 *
 * @author chiangyang
 */
import { EditorView as CMView, basicSetup } from 'codemirror'
import { markdown as cmMarkdown } from '@codemirror/lang-markdown'

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
