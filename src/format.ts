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
 * 快捷键由 src/shortcuts.ts 的配置驱动（用户在设置面板可自定义），
 * keymap 与主进程菜单 accelerator 读同一份配置，避免两处漂移。
 *
 * Markdown 无下划线语法，故不提供 Ctrl+U（数据格式纯文本原则，见路线图）。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { Command, EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { loadShortcuts, eventToAccelerator, isSameAccelerator } from './shortcuts'

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

/**
 * 块级类型 toggle：当前光标所在块就是目标类型 + 目标属性时变回段落，
 * 否则变成目标类型（setBlockType 单向设为 → Typora 式 toggle）。
 *
 * - 普通段落按 Ctrl+1 → h1；h1 再按 Ctrl+1 → 段落（toggle off）
 * - h2 按 Ctrl+1 → h1（切换 level，不 toggle off）
 * - 选区跨多块时按光标所在块判定（与 Typora 一致）
 */
function toggleBlockType(
  nodeType: import('@milkdown/kit/prose/model').NodeType,
  attrs: Record<string, unknown> | null,
): Command {
  return (state, dispatch) => {
    const current = state.selection.$from.parent
    const sameType = current.type === nodeType
    const sameAttrs = attrs == null || Object.entries(attrs).every(([k, v]) => current.attrs[k] === v)
    if (sameType && sameAttrs) {
      return setBlockType(state.schema.nodes.paragraph)(state, dispatch)
    }
    return setBlockType(nodeType, attrs ?? undefined)(state, dispatch)
  }
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
  'fmt-h1': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 1 }),
  'fmt-h2': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 2 }),
  'fmt-h3': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 3 }),
  'fmt-h4': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 4 }),
  'fmt-h5': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 5 }),
  'fmt-h6': (v) => toggleBlockType(v.state.schema.nodes.heading, { level: 6 }),
  'fmt-paragraph': (v) => setBlockType(v.state.schema.nodes.paragraph),
  'fmt-quote': () => toggleBlockquote,
  'fmt-codeblock': (v) => toggleBlockType(v.state.schema.nodes.code_block, null),
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

/**
 * 格式化快捷键（配置驱动，ProseMirror handleKeyDown）。
 *
 * 每次按键实时读取 src/shortcuts.ts 的配置并匹配 fmt-* action，
 * 因此用户在设置面板改键后立即生效，无需重建编辑器。
 * 与主进程菜单 accelerator 读同一份配置，两边行为一致。
 *
 * - 浏览器模式无菜单栏，靠这条路径触发格式化命令
 * - 源码模式（CodeMirror）不挂 ProseMirror 编辑器，本插件自然失效
 */
export const formatKeymap = $prose(() =>
  new Plugin({
    key: new PluginKey('tmd-format-keymap'),
    props: {
      handleKeyDown(view, event) {
        const acc = eventToAccelerator(event)
        // 必须带修饰键：避免单字符键吞掉正常输入（设置面板亦按此约束校验）
        if (!acc.includes('+')) return false
        const shortcuts = loadShortcuts()
        for (const [action, accelerator] of Object.entries(shortcuts)) {
          if (!action.startsWith('fmt-')) continue
          if (isSameAccelerator(acc, accelerator)) return applyFormatAction(view, action)
        }
        return false
      },
    },
  }),
)
