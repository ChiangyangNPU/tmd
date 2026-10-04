/**
 * 编辑区右键上下文菜单（所见即所得与源码两侧共用同一菜单 DOM）
 *
 * - 自绘 HTML 菜单：复用 ⋯ 溢出菜单的 .menu-item 样式与交互，主题 CSS 变量
 *   自动跟随深浅色，浏览器模式同样可用
 * - 剪切/复制/粘贴：目标侧聚焦后 document.execCommand——Electron 下粘贴会
 *   产生真实 paste 事件，ProseMirror 走完整粘贴管线（HTML/图片/markdown 全
 *   保真，粘贴图片策略自动生效），CodeMirror 由自身 paste 处理插入纯文本；
 *   浏览器模式 execCommand('paste') 被禁用，两侧均降级为剪贴板 API 插入纯文本
 *   （Electron 无默认右键菜单，源码侧此前右键无任何菜单，Windows 尤其反直觉）
 * - 格式化项：复用 format.ts 的统一命令（fmt-* action），仅所见即所得侧显示；
 *   分屏只读跟随侧（CM 不可编辑）退化为仅复制
 * - 显隐：按目标侧、选区与链接上下文动态裁剪（resolveMenuEntries 纯函数，可单测）
 *
 * @author chiangyang
 */
import { getPmView, isSourceMode, getSourceView } from './editor-core'
import type { EditorView as SourceView } from 'codemirror'
import { EditorView as CMFacets } from 'codemirror'
import { applyFormatAction, toggleLink } from './format'

/** 单个菜单项：DOM 用 data-cm-action 关联 */
type MenuAction =
  'cut' | 'copy' | 'paste' | 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'remove-link'

/** 右键命中的编辑侧：菜单动作分发据此选择 ProseMirror 或 CodeMirror */
export type MenuSide = 'wysiwyg' | 'source'

/** 当前菜单面向的一侧（打开时记录，菜单项点击时分发） */
let menuSide: MenuSide = 'wysiwyg'

/**
 * 计算当前上下文应显示的菜单项（顺序即显示顺序）。
 * 所见即所得：无选区仅粘贴；有选区：剪切/复制 + 内联格式组（链接项按是否已链接切换）。
 * 源码：只有剪切/复制/粘贴（格式化是 ProseMirror 专属命令）；只读跟随侧退化为仅复制。
 */
export function resolveMenuEntries(
  hasSelection: boolean,
  hasLink: boolean,
  side: MenuSide = 'wysiwyg',
  sourceEditable = true,
): MenuAction[] {
  if (side === 'source') {
    if (!sourceEditable) return hasSelection ? ['copy'] : []
    return hasSelection ? ['cut', 'copy', 'paste'] : ['paste']
  }
  if (!hasSelection) return ['paste']
  return [
    'cut',
    'copy',
    'paste',
    'bold',
    'italic',
    'strike',
    'code',
    hasLink ? 'remove-link' : 'link',
  ]
}

/** 按解析结果显隐菜单项与分组分隔线 */
function reflectEntries(entries: MenuAction[]) {
  const menu = document.getElementById('context-menu')
  if (!menu) return
  menu.querySelectorAll<HTMLElement>('[data-cm-action]').forEach((el) => {
    el.hidden = !entries.includes(el.dataset.cmAction as MenuAction)
  })
  // 分隔线：上下任意一侧可见即显示
  menu.querySelectorAll<HTMLElement>('.menu-sep').forEach((sep) => {
    const visibleSibling = (dir: (el: Element) => Element | null): boolean => {
      let sib = dir(sep) as HTMLElement | null
      while (sib) {
        if (!sib.hidden && sib.tagName === 'BUTTON') return true
        sib = dir(sib) as HTMLElement | null
      }
      return false
    }
    sep.hidden = !(
      visibleSibling((el) => el.previousElementSibling) &&
      visibleSibling((el) => el.nextElementSibling)
    )
  })
}

/** 关闭菜单 */
export function closeContextMenu() {
  const menu = document.getElementById('context-menu')
  if (menu) menu.hidden = true
}

/** 在光标处弹出菜单（视口内钳位；条目为空时不弹出，仅收起可能残留的旧菜单） */
function openContextMenu(x: number, y: number, entries: MenuAction[], side: MenuSide) {
  const menu = document.getElementById('context-menu')
  if (!menu) return
  if (!entries.length) {
    closeContextMenu()
    return
  }
  menuSide = side
  reflectEntries(entries)
  menu.hidden = false
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
}

/** 当前选区是否带链接标记 */
function selectionHasLink(): boolean {
  const view = getPmView()
  if (!view) return false
  const link = view.state.schema.marks.link
  if (!link) return false
  const { from, to, empty, $from } = view.state.selection
  return empty
    ? $from.marks().some((m) => m.type === link)
    : view.state.doc.rangeHasMark(from, to, link)
}

/** 菜单项动作分发 */
function runAction(action: MenuAction) {
  if (menuSide === 'source') {
    const cm = getSourceView()
    if (!cm) return
    cm.focus()
    switch (action) {
      case 'cut':
      case 'copy':
        document.execCommand(action)
        break
      case 'paste':
        if (!document.execCommand('paste')) void pasteViaClipboardApiCm(cm)
        break
      default:
        break // 格式化项仅所见即所得侧显示，不会到达
    }
    return
  }
  const view = getPmView()
  if (!view || isSourceMode()) return
  view.focus()

  switch (action) {
    case 'cut':
    case 'copy':
      // PM 监听真实 copy/cut 事件并按 schema 序列化（保留格式）
      document.execCommand(action)
      break
    case 'paste':
      // Electron：真实 paste 事件，全保真（含粘贴图片策略）；浏览器降级纯文本
      if (!document.execCommand('paste')) void pasteViaClipboardApi(view)
      break
    case 'link':
      toggleLink(view)
      break
    case 'remove-link':
      toggleLink(view) // 已带链接时 toggleLink 即移除
      break
    default:
      applyFormatAction(view, `fmt-${action}`)
  }
}

/** 浏览器模式降级：剪贴板 API 读文本插入（丢失富格式，属已知限制） */
async function pasteViaClipboardApi(view: import('@milkdown/kit/prose/view').EditorView) {
  try {
    const text = await navigator.clipboard.readText()
    if (text) view.dispatch(view.state.tr.insertText(text))
  } catch {
    // 无权限或无内容：静默忽略
  }
}

/** 源码侧同款降级：剪贴板纯文本插入 CodeMirror 选区处 */
async function pasteViaClipboardApiCm(cm: SourceView) {
  try {
    const text = await navigator.clipboard.readText()
    if (text) cm.dispatch(cm.state.replaceSelection(text))
  } catch {
    // 无权限或无内容：静默忽略
  }
}

/** 装配右键菜单（boot 调用一次；所见即所得与源码两侧） */
export function wireContextMenu(): void {
  const editorEl = document.getElementById('editor')
  const srcEl = document.getElementById('src-editor')
  const menu = document.getElementById('context-menu')

  editorEl?.addEventListener('contextmenu', (e) => {
    if (isSourceMode()) return // 纯源码模式下所见即所得整体隐藏，防御性保留
    e.preventDefault()
    const view = getPmView()
    const hasSelection = !!view && !view.state.selection.empty
    openContextMenu(
      e.clientX,
      e.clientY,
      resolveMenuEntries(hasSelection, selectionHasLink()),
      'wysiwyg',
    )
  })

  // 源码侧（纯源码模式 + 分屏源码栏共用）：CodeMirror 挂载在固定容器内，
  // 实例随模式切换重建，监听挂在容器上无需重绑
  srcEl?.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const cm = getSourceView()
    const hasSelection = !!cm && !cm.state.selection.main.empty
    const editable = cm ? cm.state.facet(CMFacets.editable) : true
    openContextMenu(
      e.clientX,
      e.clientY,
      resolveMenuEntries(hasSelection, false, 'source', editable),
      'source',
    )
  })

  menu?.querySelectorAll<HTMLElement>('[data-cm-action]').forEach((el) => {
    el.addEventListener('click', () => {
      closeContextMenu()
      runAction(el.dataset.cmAction as MenuAction)
    })
  })

  // 点击菜单外任意位置关闭（与 ⋯ 溢出菜单同一模式）
  document.addEventListener('click', (e) => {
    if (!menu || menu.hidden) return
    if (!(e.target as HTMLElement).closest('#context-menu')) closeContextMenu()
  })

  // 编辑两侧之外右键（侧边栏 / 标题栏 / 标签栏等）：先关掉残留菜单，避免旧菜单停在原处
  document.addEventListener('contextmenu', (e) => {
    if (!menu || menu.hidden) return
    if (!(e.target as HTMLElement).closest('#editor, #src-editor')) closeContextMenu()
  })
}
