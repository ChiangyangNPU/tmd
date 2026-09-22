/**
 * 编辑器枢纽：Milkdown 编辑器实例的创建/销毁/重建、源码模式切换、内容取回。
 *
 * 应用状态（标签页、保存、大纲）不直接耦合在这里——通过 setEditorHooks 注入：
 * 文档变更时回调 onMarkdownChange（保存恢复副本/字数/脏标记）与
 * onDocUpdate（大纲刷新），由 main.ts 装配，避免与 tabs 等模块循环依赖。
 */
import { Editor, defaultValueCtx, editorViewCtx, parserCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark, hardbreakFilterNodes } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { getMarkdown } from '@milkdown/kit/utils'
import { prism } from '@milkdown/plugin-prism'
import { math } from '@milkdown/plugin-math'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Slice } from '@milkdown/kit/prose/model'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { mermaidPlugins } from './mermaid'
import { pasteImage } from './paste-image'
import { pasteHtml } from './paste-html'
import { findPlugin, findClear, findTextRanges } from './find'
import { taskListClick } from './task-list'
import { tocPlugins, fillTocBlocks } from './toc'
import { markPlugins } from './mark-ext'
import { frontmatterInputRule, frontmatterPlugins } from './frontmatter'
import { imageSrcResolver } from './image-resolver'
import { imageAttrsPlugins } from './image-attrs'
import { linkNav } from './link-nav'
import { tableToolbar } from './table-toolbar'
import { tableInputPlugin } from './table-input'
import {
  normalizeEmptyTableCells,
  patchTableHardbreak,
  tableHardbreakPlugin,
} from './table-markdown'
import { patchTextEscaping, pipeBreakEscapingRemark } from './text-escaping'
import { formatKeymap } from './format'
import { focusPlugin } from './writing-modes'
import { collectOutline, renderOutline } from './outline'
import { createSourceEditor } from './sourcemode'
import type { EditorView as SourceView } from 'codemirror'
import { t } from './i18n'

/** 视图模式：所见即所得 / 纯源码 / 左右分屏（源码 + 所见即所得） */
export type ViewMode = 'wysiwyg' | 'source' | 'split'
/** 分屏中可编辑的一侧：'pm' 所见即所得 / 'cm' 源码 */
export type SplitPane = 'pm' | 'cm'

/** 分屏内容同步的防抖窗口（毫秒）：跟随时略滞后，但避免每次按键全量替换对侧文档 */
const SPLIT_SYNC_DEBOUNCE_MS = 200

/** 当前编辑器实例 */
let editor: Editor | null = null
/** 当前 ProseMirror 视图（供大纲/查找等模块直接操作文档） */
let pmView: EditorView | null = null
/**
 * 视图模式：
 * - wysiwyg：仅所见即所得（默认）
 * - source：仅源码（CodeMirror 整篇编辑）
 * - split：左右分屏，源码与所见即所得并排，其中一侧可编辑、另一侧只读跟随
 */
let viewMode: ViewMode = 'wysiwyg'
/** 分屏中当前可编辑的一侧（'pm' 所见即所得 / 'cm' 源码） */
let activePane: SplitPane = 'pm'
/** 源码侧实例（源码模式与分屏期间存在；分屏只读时为只读实例） */
let cmView: SourceView | null = null
/** 同步中标志：阻断「A 侧改动 → 同步给 B → B 变更回调 → 又同步回 A」的回环 */
let syncing = false
/** 两个方向的同步防抖定时器 */
let pmSyncTimer: number | undefined
let cmSyncTimer: number | undefined

/**
 * 文档变更钩子（main.ts 装配）。
 *
 * 变更分两路通知：onDocDirty 同步回调（O(1)、每键必做——置脏驱动关闭保护与
 * 标签圆点）；onMarkdownChange 由本模块合并调度（O(文档大小) 的序列化在低优
 * 时段执行，见 scheduleMarkdownSync），恢复副本 / 字数统计 / 分屏同步等 O(n)
 * 消费者挂这里。onDocUpdate 同步携带 doc 节点引用（无序列化），大纲等消费
 * 者按需取舍。
 */
interface EditorHooks {
  onDocDirty: () => void
  onMarkdownChange: (markdown: string) => void
  onDocUpdate: (doc: ProseNode) => void
}

let hooks: EditorHooks = { onDocDirty: () => {}, onMarkdownChange: () => {}, onDocUpdate: () => {} }

/** 注入文档变更钩子（main.ts 装配时调用一次） */
export function setEditorHooks(next: EditorHooks) {
  hooks = next
}

// ---------------------------------------------------------------------------
// 变更序列化的低优合并调度
// ---------------------------------------------------------------------------

/** 输入暂停该时长后序列化一次：连续输入期间 O(n) 序列化完全不占输入帧 */
const MD_SYNC_DEBOUNCE_MS = 800
/** 持续输入下恢复副本的最大滞后：超过即强制落一次（与磁盘自动保存 5s 同数量级） */
const MD_SYNC_MAX_STALE_MS = 5000
let mdSyncTimer: number | undefined
/** 本轮合并窗口内首个待处理变更的时间（用于计算是否超过最大滞后） */
let mdSyncFirstPendingAt = Infinity

/**
 * 安排一次「当前文档 → markdown」序列化并回调 onMarkdownChange。
 *
 * milkdown 的 markdownUpdated 回调逐键全量序列化，368K 文档上单次约 90ms，
 * 逐键执行占了大文档输入延迟的大头（实测 78ms）。序列化无法增量，故改为
 * 防抖合并：输入暂停 500ms 后落一次，连续输入期间不占任何输入帧；上限 5s
 * 强制落一次（与磁盘自动保存同数量级），恢复副本不被连续输入饿死。
 */
function scheduleMarkdownSync() {
  const now = performance.now()
  if (mdSyncFirstPendingAt === Infinity) mdSyncFirstPendingAt = now
  // 防抖重排：每次按键推倒重来；自首个待处理变更起超过上限则立即落（防饿死）
  const waited = now - mdSyncFirstPendingAt
  const delay = Math.max(0, Math.min(MD_SYNC_DEBOUNCE_MS, MD_SYNC_MAX_STALE_MS - waited))
  if (mdSyncTimer !== undefined) window.clearTimeout(mdSyncTimer)
  mdSyncTimer = window.setTimeout(runMarkdownSync, delay)
}

/** 立即执行挂起的序列化（防抖到期或最大滞后兜底时调用） */
function runMarkdownSync() {
  mdSyncTimer = undefined
  mdSyncFirstPendingAt = Infinity
  // 编辑器已销毁（换标签 / 关窗的间隙）：跳过本次，不把空串写进恢复副本
  if (!editor) return
  const md = pmMarkdown()
  // 分屏且所见即所得为编辑侧时，把改动同步给只读的源码栏（内部自带防抖）
  syncPmToSource(md)
  hooks.onMarkdownChange(md)
}

/** 立即落掉挂起中的序列化（窗口关闭前调用，保证恢复副本覆盖到最后一次输入） */
export function flushMarkdownSync() {
  if (mdSyncTimer !== undefined) runMarkdownSync()
}

/** 取当前 ProseMirror 视图实例（编辑器未挂载时为 null） */
export function getPmView(): EditorView | null {
  return pmView
}

/** 当前是否处于「纯源码」模式（分屏不算：分屏里所见即所得仍是权威编辑区） */
export function isSourceMode(): boolean {
  return viewMode === 'source'
}

/** 当前视图模式 */
export function getViewMode(): ViewMode {
  return viewMode
}

/** 分屏中当前可编辑的一侧 */
export function getSplitActivePane(): SplitPane {
  return activePane
}

/**
 * 所见即所得侧当前是否为「可编辑侧」。
 *
 * 纯源码模式下它整体不可用；分屏中源码为编辑侧时它是只读跟随——
 * 这两种情况下对 ProseMirror 的格式化 / 查找替换要么无处生效，要么会被
 * 下一次源码→所见即所得同步覆盖，调用方（格式菜单、查找栏）应据此跳过。
 */
export function canEditWysiwyg(): boolean {
  return viewMode !== 'source' && activePane === 'pm'
}

/** 视图模式 / 可编辑侧变化订阅者（查找栏据此在模式切换后收尾） */
const viewModeListeners = new Set<() => void>()

/** 订阅视图模式或可编辑侧的变化（无取消订阅需求，生命周期与窗口一致） */
export function onViewModeChange(cb: () => void): void {
  viewModeListeners.add(cb)
}

/** 模式或可编辑侧变化后通知订阅者 */
function notifyViewModeChange() {
  for (const cb of viewModeListeners) cb()
}

/** 源码侧 CodeMirror 实例（分屏滚动同步用；无源码栏时为 null） */
export function getSourceView(): SourceView | null {
  return cmView
}

/** 刷新工具栏字数统计（去空白字符后的长度） */
export function updateWordCount(markdown: string) {
  const el = document.getElementById('word-count')
  if (el) el.textContent = t('editor.wordCount', { count: markdown.replace(/\s/g, '').length })
}

/**
 * 创建 Milkdown 编辑器实例并挂载到 #editor。
 *
 * 插件清单：frontmatter 输入规则（单独最先注册：--- 先于水平线规则）、
 * tableHardbreak（表格单元格 hardbreak ⇄ <br /> 双向转换，须早于 commonmark：
 * 先于其空行占位回收把格内 <br> 还原为 break）、
 * commonmark（基础语法；配置 hardbreakFilterNodes 放开表格内 Shift+Enter
 * 硬换行）、gfm（表格/任务列表/脚注）、
 * pipeBreakEscaping（取消段落行首 | 的保守转义，须晚于 gfm）、
 * history（撤销重做）、
 * listener（内容监听）、mermaid（自研图表插件）、prism（代码高亮）、
 * math（KaTeX 公式）、pasteImage（粘贴图片）、pasteHtml（HTML 粘贴转换）、
 * findPlugin（查找高亮）、taskListClick（任务复选框）、toc（目录块）、
 * markExt（==高亮==/^上标^/~下标~，须晚于 gfm：单波浪纠正依赖其 delete 解析）、
 * frontmatter（YAML 元信息块 schema/视图，须晚于 commonmark 注册）、
 * imageSrcResolver（相对路径图片）、linkNav（链接点击跳转）、
 * tableToolbar（表格悬浮工具栏）、
 * tableInput（Typora 式管道行回车自动成表；Mod-Enter 表格内下方插行，
 * 晚于 gfm）、
 * formatKeymap（格式化快捷键）、
 * focusPlugin（专注模式变暗装饰器）、imageAttrs（图片缩放/对齐）。
 */
async function createEditor(markdown: string): Promise<Editor> {
  return (
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, document.getElementById('editor'))
        ctx.set(defaultValueCtx, markdown)
        // 恢复文本转义：milkdown 的 text handler 早退捷径会漏转义表格单元格里的 `|`
        patchTextEscaping(ctx)
        // 表格单元格内 hardbreak 序列化为 <br />（默认 break handler 的物理换行
        // 会被 gfm-table 压扁成空格）；格内 <br> 解析还原由 tableHardbreakPlugin 处理
        patchTableHardbreak(ctx)
        // 允许表格单元格内 Shift+Enter 插入硬换行：commonmark 的 hardbreakFilterPlugin
        // 默认把 table 列为禁区（filterTransaction 直接丢弃插入事务），从过滤名单移除
        // table；code_block 仍保留（代码块内硬换行无意义，由代码块自行处理按键）
        // $ctx 产物是 plugin 函数，SliceType 挂在其 .key 上（update 第二参为 updater）
        ctx.update(hardbreakFilterNodes.key, () => ['code_block'])
        // 文档变更通知拆两路（见 EditorHooks）：置脏同步 O(1)；序列化合并低优调度——
        // markdownUpdated 回调逐键全量 getMarkdown 曾占大文档输入延迟的大头（§26.3）
        ctx.get(listenerCtx).updated((_ctx, doc) => {
          hooks.onDocDirty()
          hooks.onDocUpdate(doc)
          scheduleMarkdownSync()
        })
      })
      // 仅输入规则最先注册：文档开头输入 --- 要先于 commonmark 的水平线规则
      // （二者同匹配 ---，InputRule 按注册顺序首个生效）。schema 等其余部分
      // 不能提前：frontmatter 是 block 节点，先注册会被空文档自动补块误选
      .use(frontmatterInputRule)
      // 表格单元格硬换行双向转换（break ⇄ <br />）。必须早于 commonmark 注册：
      // 其 remarkPreserveEmptyLinePlugin 会删除所有 <br> html 节点，本插件需先
      // 把表格内有内容单元格的 <br> 还原为 break（详见 table-markdown.ts）
      .use(tableHardbreakPlugin)
      .use(commonmark)
      .use(gfm)
      // 取消普通段落行首「| 」的保守反斜杠转义（须晚于 gfm：过滤其注册的
      // unsafe 规则，详见 text-escaping.ts 修复二）
      .use(pipeBreakEscapingRemark)
      .use(history)
      .use(listener)
      .use(mermaidPlugins)
      .use(prism)
      .use(math)
      .use(pasteImage)
      .use(pasteHtml)
      .use(findPlugin)
      .use(taskListClick)
      .use(tocPlugins)
      // 扩展行内标记：晚于 gfm（~x~ 纠正依赖 remark-gfm 的 delete 词法解析）
      .use(markPlugins)
      // front matter 的 schema/remark/view（其输入规则已在最前面单独注册）
      .use(frontmatterPlugins)
      .use(imageSrcResolver)
      // 图片缩放/对齐：schema 扩展必须晚于 commonmark 注册（同名覆盖）
      .use(imageAttrsPlugins)
      .use(linkNav)
      .use(tableToolbar)
      // Typora 式表格按键：段落管道行回车即转真表格；
      // Mod-Enter（Ctrl/Cmd+Enter）在表格内当前行下方插入空行
      .use(tableInputPlugin)
      .use(formatKeymap)
      .use(focusPlugin)
      .create()
  )
}

/** 创建编辑器并挂载（启动时用） */
export async function mountEditor(markdown: string): Promise<void> {
  editor = await createEditor(markdown)
  editor.action((ctx) => {
    pmView = ctx.get(editorViewCtx)
  })
}

/** 销毁当前编辑器（关闭最后一个标签时用） */
export async function destroyEditor() {
  await editor?.destroy()
  editor = null
  pmView = null
}

/** 重建编辑器时的可选行为（滚动保持/恢复） */
export interface ReplaceOptions {
  /** 重建前后内容相同（退出源码模式）时保持滚动位置：锁定 #editor 高度防塌陷 */
  preserveScroll?: boolean
  /** 目标滚动位置（切换标签恢复用）；异步内容增高导致位置被钳回时延迟校正一次 */
  scrollTop?: number
}

/** 重建序号：让异步收尾（rAF 解锁 / 延迟校正）能识别自己是否已过期 */
let replaceSeq = 0

/** 串行化：快速连续切换标签/打开文件时避免并发重建互相踩踏（产生多个编辑器实例） */
let replaceQueue: Promise<void> = Promise.resolve()

/**
 * 重建编辑器：销毁旧实例并用新文档挂载。
 * 入队串行执行，避免并发重建踩踏；失败仅记录日志，不中断队列。
 * @param markdown - 新文档内容
 * @param options - 滚动位置保持/恢复选项
 * @returns 本次重建完成的 Promise
 */
export function replaceEditor(markdown: string, options: ReplaceOptions = {}): Promise<void> {
  replaceQueue = replaceQueue
    .then(() => doReplaceEditor(markdown, options))
    .catch((err) => console.error('[tmd] 编辑器重建失败', err))
  return replaceQueue
}

/**
 * 销毁当前编辑器并用新文档重建（打开文件 / 切换标签 / 退出源码模式共用）。
 * preserveScroll：重建期间锁定 #editor 高度，防止内容塌陷导致滚动条闪烁、
 * scrollTop 被归零。新编辑器刚挂载时图片未解码、mermaid 未渲染，内容高度会
 * 先矮后高，所以锁定要持续到内容高度补回原值为止。
 */
async function doReplaceEditor(markdown: string, options: ReplaceOptions) {
  const { preserveScroll = false, scrollTop } = options
  const seq = ++replaceSeq
  const scrollEl = document.querySelector('.page-scroll') as HTMLElement | null
  const editorEl = document.getElementById('editor')
  const prevTop = scrollTop ?? scrollEl?.scrollTop ?? 0
  const prevHeight = editorEl?.offsetHeight ?? 0

  if (preserveScroll && editorEl && prevHeight > 0) {
    editorEl.style.minHeight = `${prevHeight}px`
  }

  findClear(pmView)
  await editor?.destroy()
  editor = await createEditor(markdown)
  editor.action((ctx) => {
    pmView = ctx.get(editorViewCtx)
  })
  updateWordCount(markdown)
  const list = document.getElementById('outline-list')
  if (list && pmView) renderOutline(list, collectOutline(pmView.state.doc), pmView)
  // 重建后重新应用视图模式：分屏/源码下切换标签应保持该模式，源码栏内容换成新文档
  reapplyViewMode()

  if (preserveScroll && editorEl) {
    const inner = editorEl.firstElementChild as HTMLElement | null
    const deadline = performance.now() + 1500
    const unlock = () => {
      // 已有更新的重建接管：放弃本轮的解锁与滚动恢复
      if (seq !== replaceSeq) return
      const caughtUp = inner ? inner.offsetHeight >= prevHeight - 1 : true
      if (!caughtUp && performance.now() < deadline) {
        requestAnimationFrame(unlock)
        return
      }
      editorEl.style.minHeight = ''
      if (scrollEl) scrollEl.scrollTop = prevTop
    }
    requestAnimationFrame(unlock)
  } else if (scrollTop != null && scrollEl) {
    // 目标滚动位置：立即恢复；若异步内容（图片解码/mermaid 渲染）尚未增高，
    // scrollTop 会被钳到更小值，500ms 后校正一次。用户主动滚动（滚轮/拖拽/
    // 键盘）或已有更新的重建时放弃校正，避免与用户操作打架
    scrollEl.scrollTop = prevTop
    let cancelled = false
    const cancel = () => {
      cancelled = true
      for (const type of ['wheel', 'pointerdown', 'keydown'])
        scrollEl.removeEventListener(type, cancel)
    }
    for (const type of ['wheel', 'pointerdown', 'keydown'])
      scrollEl.addEventListener(type, cancel, { passive: true })
    window.setTimeout(() => {
      for (const type of ['wheel', 'pointerdown', 'keydown'])
        scrollEl.removeEventListener(type, cancel)
      if (!cancelled && seq === replaceSeq && scrollEl.scrollTop < prevTop)
        scrollEl.scrollTop = prevTop
    }, 500)
  }
}

/**
 * 取当前编辑器内容的 markdown 文本。
 * 源码为编辑侧时（纯源码模式，或分屏中源码为主要编辑区）以 CodeMirror 内容为准
 * ——所见即所得侧此时是只读跟随，存在同步防抖延迟。
 */
export function currentMarkdown(): string {
  if (cmView && (viewMode === 'source' || (viewMode === 'split' && activePane === 'cm'))) {
    return cmView.state.doc.toString()
  }
  return pmMarkdown()
}

/**
 * 所见即所得侧的 markdown（不带源码侧分支）。
 *
 * 与 currentMarkdown 分开是必要的：把源码侧改动「并回」所见即所得前要比较两者，
 * 若用 currentMarkdown 比较，在源码为编辑侧时它返回的就是源码内容，比较必然相等、
 * 于是永远不并回——切换模式时用户的源码改动会丢。
 */
function pmMarkdown(): string {
  const markdown = editor?.action(getMarkdown()) ?? ''
  // toc 节点序列化为空注释占位，此处按当前文档标题填充为真实链接列表
  const filled = pmView ? fillTocBlocks(markdown, pmView.state.doc) : markdown
  // 空表格单元格的 <br /> 占位清空（milkdown 空段落补偿，见 table-markdown.ts）
  return normalizeEmptyTableCells(filled)
}

/**
 * 切换视图模式（所见即所得 / 纯源码 / 左右分屏）。
 *
 * 切换前若源码侧是编辑侧，先把源码改动并回所见即所得（它是文档权威，重建编辑器
 * 也以它为准）；源码栏的可编辑性写在创建时的 facet 里，故按目标模式重建实例。
 */
export function setViewMode(mode: ViewMode) {
  if (mode === viewMode) return
  const srcEl = document.getElementById('src-editor')
  if (!srcEl) return

  // 离开「源码为编辑侧」的场景：内容并回所见即所得，不丢用户刚写的源码
  // （比较对象取所见即所得侧，不能用 currentMarkdown——那时它返回的正是源码内容）
  if (viewMode !== 'wysiwyg' && activePane === 'cm' && cmView) {
    const markdown = cmView.state.doc.toString()
    if (markdown !== pmMarkdown()) applyMarkdownToPm(markdown)
  }

  viewMode = mode
  activePane = mode === 'source' ? 'cm' : 'pm'
  reapplyViewMode()
  updateSourceModeButton()
  notifyViewModeChange()
}

/** 编辑器重建 / 视图模式切换后重新应用：源码栏内容跟随当前文档，布局与可编辑性重设 */
function reapplyViewMode() {
  disposeSourcePane()
  if (viewMode !== 'wysiwyg') rebuildSourcePane()
  applyViewLayout()
  applyEditableState()
}

/** 兼容入口：源码模式开关（true → 纯源码，false → 所见即所得） */
export function setSourceMode(on: boolean) {
  setViewMode(on ? 'source' : 'wysiwyg')
}

/**
 * 分屏中切换可编辑侧（点哪一侧，哪一侧就可编辑）。
 *
 * 换边前先把当前编辑侧的改动并过去；源码侧可编辑性写在创建时的 facet 里，
 * 故重建源码栏——重建前记下滚动位置与点击处的文档位置，重建后恢复，
 * 避免「点过去后光标跳回开头」。
 *
 * @param pane - 目标可编辑侧
 * @param coords - 点击坐标（用于把光标落到点中的位置，可省略）
 */
export function setSplitActivePane(pane: SplitPane, coords?: { x: number; y: number }) {
  if (viewMode !== 'split' || pane === activePane) return
  if (activePane === 'cm' && cmView) {
    const markdown = cmView.state.doc.toString()
    if (markdown !== pmMarkdown()) applyMarkdownToPm(markdown)
  }
  const caret = pane === 'cm' && cmView && coords ? cmView.posAtCoords(coords) : null
  activePane = pane
  rebuildSourcePane()
  applyEditableState()
  if (caret != null && cmView) {
    cmView.dispatch({ selection: { anchor: caret } })
    cmView.focus()
  }
  notifyViewModeChange()
}

/** 销毁源码栏实例并清空容器（切换模式 / 重建编辑器时调用） */
function disposeSourcePane() {
  window.clearTimeout(pmSyncTimer)
  window.clearTimeout(cmSyncTimer)
  cmView?.destroy()
  cmView = null
  const srcEl = document.getElementById('src-editor')
  if (srcEl) srcEl.textContent = ''
}

/**
 * 按当前视图模式与可编辑侧重建源码栏（内容沿用现有实例，实例不存在时取实时文档）。
 * 只有「纯源码」或「分屏且源码为编辑侧」才创建可编辑实例，其余为只读跟随。
 */
function rebuildSourcePane() {
  const srcEl = document.getElementById('src-editor')
  if (!srcEl) return
  const markdown = cmView ? cmView.state.doc.toString() : currentMarkdown()
  const scrollTop = cmView?.scrollDOM.scrollTop ?? 0
  cmView?.destroy()
  srcEl.textContent = ''
  const editable = viewMode === 'source' || activePane === 'cm'
  cmView = createSourceEditor(srcEl, markdown, editable, onSourceChange)
  cmView.scrollDOM.scrollTop = scrollTop
}

/** 按当前视图模式应用布局（哪一栏可见、分隔条是否出现、body 上的模式类） */
function applyViewLayout() {
  const pmScroll = document.querySelector('.page-scroll')
  const srcPane = document.getElementById('src-pane')
  const divider = document.getElementById('split-divider')
  const isSource = viewMode === 'source'
  if (pmScroll instanceof HTMLElement) pmScroll.hidden = isSource
  if (srcPane) srcPane.hidden = viewMode === 'wysiwyg'
  if (divider) divider.hidden = viewMode !== 'split'
  document.body.classList.toggle('view-source', isSource)
  document.body.classList.toggle('view-split', viewMode === 'split')
  // 源码模式：PM 编辑器保留（仅隐藏），插件 view 不会触发 destroy，
  // 表格工具栏需显式隐藏
  if (isSource) document.getElementById('table-toolbar')?.setAttribute('hidden', '')
}

/** 应用两栏可编辑性：分屏时仅 activePane 一侧可编辑，另一侧只读跟随 */
function applyEditableState() {
  const pmEditable = !(viewMode === 'split' && activePane === 'cm')
  pmView?.setProps({ editable: () => pmEditable })
}

/** 同步工具栏「源码模式」按钮文案 */
function updateSourceModeButton() {
  const btn = document.getElementById('source-mode-btn')
  if (btn) {
    btn.textContent = viewMode === 'source' ? t('toolbar.sourceModeOn') : t('toolbar.sourceMode')
  }
}

/** 分屏（所见即所得为编辑侧）时，把改动防抖同步给只读的源码栏 */
function syncPmToSource(markdown: string) {
  if (viewMode !== 'split' || activePane !== 'pm' || !cmView) return
  window.clearTimeout(pmSyncTimer)
  pmSyncTimer = window.setTimeout(() => {
    if (viewMode !== 'split' || activePane !== 'pm' || !cmView) return
    if (cmView.state.doc.toString() === markdown) return
    syncing = true
    try {
      cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: markdown } })
    } finally {
      syncing = false
    }
  }, SPLIT_SYNC_DEBOUNCE_MS)
}

/**
 * 源码栏变更回调。
 * 纯源码模式不实时同步（退出时一次性并回，与既有行为一致）；
 * 分屏且源码为编辑侧时，防抖把改动推给只读的所见即所得侧。
 */
function onSourceChange(markdown: string) {
  if (syncing || viewMode !== 'split' || activePane !== 'cm') return
  window.clearTimeout(cmSyncTimer)
  cmSyncTimer = window.setTimeout(() => {
    if (viewMode !== 'split' || activePane !== 'cm') return
    syncing = true
    try {
      applyMarkdownToPm(markdown)
    } finally {
      syncing = false
    }
  }, SPLIT_SYNC_DEBOUNCE_MS)
}

/**
 * 用 markdown 原地替换所见即所得文档（不重建编辑器，保住滚动位置与撤销历史）。
 * 走 parser + Slice 事务（与 Milkdown 的 replaceAll 同源），并标记不进撤销历史
 * ——它由只读跟随或模式切换产生，不该占用用户的撤销位。
 */
function applyMarkdownToPm(markdown: string) {
  const view = pmView
  if (!editor || !view) return
  try {
    editor.action((ctx) => {
      const doc = ctx.get(parserCtx)(markdown)
      if (!doc) return
      view.dispatch(
        view.state.tr
          .replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
          .setMeta('addToHistory', false),
      )
    })
  } catch (err) {
    console.error('[tmd] 同步到所见即所得失败', err)
  }
}

/**
 * 源码模式：定位到关键词的第 occurrence 个匹配，选中并滚入视野。
 *
 * 与所见即所得路径同一策略——不用主进程返回的磁盘行号，而是在实时文档内
 * 重新匹配取第 N 个：进入源码模式前 markdown 经过序列化（空行、语法字符会
 * 被规范化），且源码文档可被继续编辑，行号未必与磁盘文件一致。
 * 滚动交给 CodeMirror：其 scrollRectIntoView 会向上寻找可滚动祖先并滚动之
 * （源码模式下 #src-editor 的 height:100% 对自动高度的父级不生效，CM 自身
 * 的 scroller 不产生滚动，实际滚动的是 .page-scroll），故无需手工算滚动量，
 * 与 ProseMirror 侧必须手动算滚动量不同。
 * @param query - 搜索关键词（大小写不敏感）
 * @param occurrence - 目标匹配在文档内的序号（1 起始）；匹配数不足时退回最后一个
 * @returns 是否成功定位（非源码模式、关键词为空或无匹配时为 false）
 */
export function jumpToSourceMatch(query: string, occurrence: number): boolean {
  if (!isSourceMode() || !cmView) return false
  const ranges = findTextRanges(cmView.state.doc.toString(), query)
  if (!ranges.length) return false
  const target = ranges[Math.min(Math.max(occurrence, 1), ranges.length) - 1]
  cmView.dispatch({
    selection: { anchor: target.from, head: target.to },
    scrollIntoView: true,
  })
  cmView.focus()
  return true
}
