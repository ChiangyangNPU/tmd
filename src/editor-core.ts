/**
 * 编辑器枢纽：Milkdown 编辑器实例的创建/销毁/重建、源码模式切换、内容取回。
 *
 * 应用状态（标签页、保存、大纲）不直接耦合在这里——通过 setEditorHooks 注入：
 * 文档变更时回调 onMarkdownChange（保存恢复副本/字数/脏标记）与
 * onDocUpdate（大纲刷新），由 main.ts 装配，避免与 tabs 等模块循环依赖。
 */
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { getMarkdown } from '@milkdown/kit/utils'
import { prism } from '@milkdown/plugin-prism'
import { math } from '@milkdown/plugin-math'
import type { EditorView } from '@milkdown/kit/prose/view'
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
import { normalizeEmptyTableCells } from './table-markdown'
import { patchTextEscaping, pipeBreakEscapingRemark } from './text-escaping'
import { formatKeymap } from './format'
import { focusPlugin } from './writing-modes'
import { collectOutline, renderOutline } from './outline'
import { createSourceEditor } from './sourcemode'
import type { EditorView as SourceView } from 'codemirror'
import { t } from './i18n'

/** 当前编辑器实例 */
let editor: Editor | null = null
/** 当前 ProseMirror 视图（供大纲/查找等模块直接操作文档） */
let pmView: EditorView | null = null
/** 是否处于源码模式（CodeMirror 整篇编辑） */
let sourceMode = false
/** 源码模式下的 CodeMirror 实例（仅源码模式期间存在） */
let cmView: SourceView | null = null

/** 文档变更钩子（main.ts 装配） */
interface EditorHooks {
  onMarkdownChange: (markdown: string) => void
  onDocUpdate: (doc: ProseNode) => void
}

let hooks: EditorHooks = { onMarkdownChange: () => {}, onDocUpdate: () => {} }

/** 注入文档变更钩子（main.ts 装配时调用一次） */
export function setEditorHooks(next: EditorHooks) {
  hooks = next
}

/** 取当前 ProseMirror 视图实例（编辑器未挂载时为 null） */
export function getPmView(): EditorView | null {
  return pmView
}

/** 当前是否处于源码模式 */
export function isSourceMode(): boolean {
  return sourceMode
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
 * commonmark（基础语法）、gfm（表格/任务列表/脚注）、
 * pipeBreakEscaping（取消段落行首 | 的保守转义，须晚于 gfm）、
 * history（撤销重做）、
 * listener（内容监听）、mermaid（自研图表插件）、prism（代码高亮）、
 * math（KaTeX 公式）、pasteImage（粘贴图片）、pasteHtml（HTML 粘贴转换）、
 * findPlugin（查找高亮）、taskListClick（任务复选框）、toc（目录块）、
 * markExt（==高亮==/^上标^/~下标~，须晚于 gfm：单波浪纠正依赖其 delete 解析）、
 * frontmatter（YAML 元信息块 schema/视图，须晚于 commonmark 注册）、
 * imageSrcResolver（相对路径图片）、linkNav（链接点击跳转）、
 * tableToolbar（表格悬浮工具栏）、
 * tableInput（Typora 式「表头行+分隔行」回车自动成表，晚于 gfm）、
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
        ctx.get(listenerCtx).markdownUpdated((_ctx, md, _prev) => {
          hooks.onMarkdownChange(md)
        })
        ctx.get(listenerCtx).updated((_ctx, doc) => {
          hooks.onDocUpdate(doc)
        })
      })
      // 仅输入规则最先注册：文档开头输入 --- 要先于 commonmark 的水平线规则
      // （二者同匹配 ---，InputRule 按注册顺序首个生效）。schema 等其余部分
      // 不能提前：frontmatter 是 block 节点，先注册会被空文档自动补块误选
      .use(frontmatterInputRule)
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
      // Typora 式输入：段落里敲完表头行与 | -- | 分隔行后回车即转真表格
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
  setSourceMode(false, false)

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

/** 取当前编辑器内容的 markdown 文本（源码模式下取 CodeMirror 内容） */
export function currentMarkdown(): string {
  if (sourceMode && cmView) return cmView.state.doc.toString()
  const markdown = editor?.action(getMarkdown()) ?? ''
  // toc 节点序列化为空注释占位，此处按当前文档标题填充为真实链接列表
  const filled = pmView ? fillTocBlocks(markdown, pmView.state.doc) : markdown
  // 空表格单元格的 <br /> 占位清空（milkdown 空段落补偿，见 table-markdown.ts）
  return normalizeEmptyTableCells(filled)
}

/**
 * 切换 所见即所得 / 源码 模式。
 * 进入时把 markdown 全文交给 CodeMirror；退出时取回全文重建编辑器。
 */
export async function setSourceMode(on: boolean, syncContent = true) {
  const pmEl = document.getElementById('editor')
  const srcEl = document.getElementById('src-editor')
  const btn = document.getElementById('source-mode-btn')
  if (!pmEl || !srcEl) return

  if (on) {
    const markdown = currentMarkdown()
    cmView?.destroy()
    srcEl.textContent = ''
    cmView = createSourceEditor(srcEl, markdown)
    // 进入源码模式：PM 编辑器保留（仅隐藏），插件 view 不会触发 destroy，
    // 表格工具栏需显式隐藏
    document.getElementById('table-toolbar')?.setAttribute('hidden', '')
  } else if (sourceMode && cmView) {
    const markdown = cmView.state.doc.toString()
    cmView.destroy()
    cmView = null
    if (syncContent) await replaceEditor(markdown, { preserveScroll: true })
  }

  sourceMode = on
  pmEl.hidden = on
  srcEl.hidden = !on
  if (btn) btn.textContent = on ? t('toolbar.sourceModeOn') : t('toolbar.sourceMode')
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
  if (!sourceMode || !cmView) return false
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
