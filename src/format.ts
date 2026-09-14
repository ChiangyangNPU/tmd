/**
 * 格式化命令层：快捷键（ProseMirror keymap）与主菜单「格式」栏共用的统一入口。
 *
 * - 命令直接操作 Milkdown schema（节点名 heading/blockquote/bullet_list/
 *   ordered_list/code_block，标记名 strong/emphasis/code/link/strike_through），
 *   走标准事务，全部可撤销
 * - keymap 路径：编辑器内按键直接生效（浏览器模式无菜单栏，靠这条路径）
 * - 菜单路径：Electron 菜单 accelerator 消费按键 → IPC menu action
 *   （fmt-*）→ main.ts 检查源码模式后调 applyFormatAction；
 *   Electron 下菜单已消费按键，keymap 不会重复触发，两路径互斥
 * - 源码模式（CodeMirror）不挂 ProseMirror 编辑器，keymap 自然失效；
 *   菜单路径由 main.ts 显式拦截
 *
 * Markdown 无下划线语法，故不提供 Ctrl+U（数据格式纯文本原则，见路线图）。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Command, EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

// ---------------------------------------------------------------------------
// 块级切换命令
// ---------------------------------------------------------------------------

/** 选区是否触及指定类型的块（祖先链 + 范围扫描双重判断——Cmd+A 全选时
 *  $from/$to 两端都停在 doc 层 depth 0，祖先链里看不到任何块，必须扫描范围） */
function inBlock(state: EditorState, nodeName: string): boolean {
  const { $from, $to, from, to } = state.selection
  const check = ($pos: import('@milkdown/kit/prose/model').ResolvedPos): boolean => {
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === nodeName) return true
    }
    return false
  }
  if (check($from) || check($to)) return true
  let hit = false
  state.doc.nodesBetween(from, to, (node) => {
    if (hit) return false
    if (node.type.name === nodeName) hit = true
    return !hit
  })
  return hit
}

/**
 * 块级命令执行兜底：Cmd+A 全选等场景选区端点在 doc 层（depth 0），
 * lift/liftListItem 的 blockRange 解析不出目标块而直接失败——
 * 先把选区钳进选区内第一个文本块，再执行命令（同一事务，一次撤销）。
 */
function withBlockSelection(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  cmd: Command,
): boolean {
  const { from, to, $from, $to } = state.selection
  if ($from.depth > 0 || $to.depth > 0) return cmd(state, dispatch)
  const anchor = TextSelection.near(state.doc.resolve(from), 1)
  const head = TextSelection.near(state.doc.resolve(to), -1)
  const inner = TextSelection.between(anchor.$anchor, head.$head)
  return cmd(state.apply(state.tr.setSelection(inner)), dispatch)
}

/** 引用切换：在引用内则提升一级退出，否则包进引用 */
export const toggleBlockquote: Command = (state, dispatch) => {
  if (inBlock(state, 'blockquote')) {
    return dispatch ? withBlockSelection(state, dispatch, (s, d) => lift(s, d)) : true
  }
  return wrapIn(state.schema.nodes.blockquote)(state, dispatch)
}

/** 列表切换：在任何列表内则把当前列表项提升退出，否则包成目标列表 */
export function toggleList(listName: 'bullet_list' | 'ordered_list'): Command {
  return (state, dispatch) => {
    if (inBlock(state, 'bullet_list') || inBlock(state, 'ordered_list')) {
      if (!dispatch) return true
      return withBlockSelection(state, dispatch, (s, d) =>
        liftListItem(s.schema.nodes.list_item)(s, d),
      )
    }
    return wrapInList(state.schema.nodes[listName])(state, dispatch)
  }
}

// ---------------------------------------------------------------------------
// 链接（Ctrl+K）：已有链接 → 移除；有选区无链接 → 弹链接栏输入地址
// ---------------------------------------------------------------------------

interface LinkBarContext {
  view: EditorView
  selection: import('@milkdown/kit/prose/state').Selection
}

let linkCtx: LinkBarContext | null = null

/** 当前选区是否已带链接标记 */
function linkActive(view: EditorView): boolean {
  const link = view.state.schema.marks.link
  if (!link) return false
  const { from, to, empty, $from } = view.state.selection
  return empty
    ? $from.marks().some((m) => m.type === link)
    : view.state.doc.rangeHasMark(from, to, link)
}

/** 链接切换：有链接移除；无链接且有选区 → 打开链接栏；纯光标不动作 */
export function toggleLink(view: EditorView): boolean {
  const link = view.state.schema.marks.link
  if (!link) return false
  if (linkActive(view)) return toggleMark(link)(view.state, view.dispatch)
  if (view.state.selection.empty) return false
  linkCtx = { view, selection: view.state.selection }
  const bar = document.getElementById('link-bar')
  const input = document.getElementById('link-input') as HTMLInputElement | null
  if (!bar || !input) return false
  bar.hidden = false
  input.value = ''
  input.focus()
  return true
}

/** 关闭链接栏（确认/取消共用）；confirm 为真时把输入的地址应用到暂存选区 */
export function closeLinkBar(confirm = false) {
  const ctx = linkCtx
  linkCtx = null
  const bar = document.getElementById('link-bar')
  if (bar) bar.hidden = true
  if (!ctx || !confirm) return
  const { view, selection } = ctx
  const input = document.getElementById('link-input') as HTMLInputElement | null
  const href = input?.value.trim() ?? ''
  // 选区可能因输入期间的事务过期：先恢复暂存选区再加标记（两个事务均可撤销）
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
  toggleMark(view.state.schema.marks.link, { href })(view.state, view.dispatch)
  view.focus()
}

/** 链接栏交互装配（boot 调用一次） */
export function wireLinkBar(): void {
  const input = document.getElementById('link-input') as HTMLInputElement | null
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      closeLinkBar(true)
    } else if (e.key === 'Escape') {
      closeLinkBar(false)
    }
  })
  document.getElementById('link-ok')?.addEventListener('click', () => closeLinkBar(true))
  document.getElementById('link-cancel')?.addEventListener('click', () => closeLinkBar(false))
}

// ---------------------------------------------------------------------------
// 统一分发与 keymap
// ---------------------------------------------------------------------------

/** 菜单 action → 命令工厂（schema 在调用时解析，避免模块加载期依赖） */
export const MENU_COMMANDS: Record<string, (view: EditorView) => Command> = {
  'fmt-bold': (v) => toggleMark(v.state.schema.marks.strong),
  'fmt-italic': (v) => toggleMark(v.state.schema.marks.emphasis),
  'fmt-strike': (v) => toggleMark(v.state.schema.marks.strike_through),
  'fmt-code': (v) => toggleMark(v.state.schema.marks.code),
  // 语法扩展（mark-ext.ts）：==高亮==、^上标^、~下标~
  'fmt-mark': (v) => toggleMark(v.state.schema.marks.highlight),
  'fmt-sup': (v) => toggleMark(v.state.schema.marks.superscript),
  'fmt-sub': (v) => toggleMark(v.state.schema.marks.subscript),
  'fmt-h1': (v) => setBlockType(v.state.schema.nodes.heading, { level: 1 }),
  'fmt-h2': (v) => setBlockType(v.state.schema.nodes.heading, { level: 2 }),
  'fmt-h3': (v) => setBlockType(v.state.schema.nodes.heading, { level: 3 }),
  'fmt-h4': (v) => setBlockType(v.state.schema.nodes.heading, { level: 4 }),
  'fmt-h5': (v) => setBlockType(v.state.schema.nodes.heading, { level: 5 }),
  'fmt-h6': (v) => setBlockType(v.state.schema.nodes.heading, { level: 6 }),
  'fmt-paragraph': (v) => setBlockType(v.state.schema.nodes.paragraph),
  'fmt-quote': () => toggleBlockquote,
  'fmt-codeblock': (v) => setBlockType(v.state.schema.nodes.code_block),
  'fmt-bullet': () => toggleList('bullet_list'),
  'fmt-ordered': () => toggleList('ordered_list'),
}

/** 菜单路径统一入口（main.ts 在非源码模式、编辑器已挂载时调用） */
export function applyFormatAction(view: EditorView, action: string): boolean {
  if (action === 'fmt-link') {
    const ok = toggleLink(view)
    if (ok) view.focus()
    return ok
  }
  const cmd = MENU_COMMANDS[action]
  if (!cmd) return false
  const ok = cmd(view)(view.state, view.dispatch, view)
  if (ok) view.focus()
  return ok
}

/** 编辑器内快捷键（浏览器模式无菜单栏，靠这条路径；Electron 下菜单 accelerator 先消费按键） */
export const formatKeymap = $prose(() =>
  keymap({
    'Mod-b': (state, dispatch) => toggleMark(state.schema.marks.strong)(state, dispatch),
    'Mod-i': (state, dispatch) => toggleMark(state.schema.marks.emphasis)(state, dispatch),
    'Mod-1': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 1 })(state, dispatch),
    'Mod-2': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 2 })(state, dispatch),
    'Mod-3': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 3 })(state, dispatch),
    'Mod-4': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 4 })(state, dispatch),
    'Mod-5': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 5 })(state, dispatch),
    'Mod-6': (state, dispatch) =>
      setBlockType(state.schema.nodes.heading, { level: 6 })(state, dispatch),
    'Mod-0': (state, dispatch) => setBlockType(state.schema.nodes.paragraph)(state, dispatch),
    // Mod-q 在 macOS 是退出应用，绑定 Ctrl+q 兜底（mac 菜单走 Ctrl+Q accelerator）
    'Mod-q': toggleBlockquote,
    'Ctrl-q': toggleBlockquote,
    'Mod-Shift-8': (state, dispatch, view) => toggleList('bullet_list')(state, dispatch, view),
    'Mod-Shift-9': (state, dispatch, view) => toggleList('ordered_list')(state, dispatch, view),
    'Mod-Shift-k': (state, dispatch) =>
      setBlockType(state.schema.nodes.code_block)(state, dispatch),
    'Mod-k': (_state, _dispatch, view) => (view ? toggleLink(view) : false),
    // 语法扩展：高亮 Cmd/Ctrl+Shift+H，上标 +Shift+=，下标 +Shift+-
    'Mod-Shift-h': (state, dispatch) => toggleMark(state.schema.marks.highlight)(state, dispatch),
    'Mod-Shift-=': (state, dispatch) => toggleMark(state.schema.marks.superscript)(state, dispatch),
    'Mod-Shift--': (state, dispatch) => toggleMark(state.schema.marks.subscript)(state, dispatch),
  }),
)
