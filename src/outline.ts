/**
 * 大纲面板：从文档收集标题（1-3 级），点击跳转到对应位置
 *
 * @author chiangyang
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'
import { t } from './i18n'
import { collectHeadings, scrollEditorPosIntoView } from './toc'

/** 大纲条目：标题级别（1-3）、文本与文档位置 */
export interface OutlineItem {
  level: number
  text: string
  pos: number
}

/** 收集 1-3 级标题（复用 toc 的标题遍历，slug 计数结果丢弃） */
export function collectOutline(doc: ProseNode): OutlineItem[] {
  return collectHeadings(doc)
    .filter((h) => h.level <= 3)
    .map(({ level, text, pos }) => ({ level, text, pos }))
}

/** 渲染大纲面板；点击条目选中对应标题并将其滚动到可视区顶部 */
export function renderOutline(container: HTMLElement, items: OutlineItem[], view: EditorView) {
  container.textContent = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = t('outline.empty')
    container.appendChild(empty)
    return
  }
  for (const item of items) {
    const row = document.createElement('div')
    row.className = `outline-item level-${item.level}`
    row.textContent = item.text || '（无标题文本）'
    row.addEventListener('click', () => {
      const $pos = view.state.doc.resolve(item.pos + 1)
      const selection = TextSelection.near($pos, 1)
      view.dispatch(view.state.tr.setSelection(selection))
      view.focus()
      // 选区落位后按实际坐标滚动（不依赖 ProseMirror 的 scrollIntoView）；
      // 顶对齐：标题始终滚到可视区最上方，已可见时也会重新定位
      scrollEditorPosIntoView(view, selection.from, 'top')
    })
    container.appendChild(row)
  }
}
