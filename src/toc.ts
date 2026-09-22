/**
 * 目录（TOC）块插件
 *
 * 功能：在文档中插入自动目录，收集全文 1-3 级标题按层级缩进展示，
 * 标题增删改后自动刷新；点击目录项跳转到对应标题（与大纲面板同源）。
 *
 * 存储格式（Markdown 文本）：
 *   <!-- TOC -->
 *   - [标题一](#标题一)
 *     - [子标题](#子标题)
 *   <!-- /TOC -->
 * 注释区间内是真实链接列表：GitHub / VS Code 等外部渲染器中目录可见可点；
 * 本应用解析时整个区间被识别为一个原子 toc 节点，内容始终动态生成。
 *
 * 组成（与 mermaid.ts 同构）：
 * 1. remark 转换：mdast 中 <!-- TOC --> 到 <!-- /TOC --> 区间合并为 toc 节点
 * 2. 节点 schema：原子块（不可编辑光标进入，整体删除）
 * 3. 节点视图：渲染目录列表，点击跳转
 * 4. prose 插件：文档变化时刷新所有 toc 视图（toc 节点自身不变，update 不会触发）
 * 5. 输入规则：空行输入 [TOC] 回车即插入目录块
 *
 * @author chiangyang
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule, $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils'
import { t } from './i18n'

// ---------------------------------------------------------------------------
// 1. remark 转换：<!-- TOC --> ... <!-- /TOC --> 区间 → toc 节点
// ---------------------------------------------------------------------------

type MdNode = { type: string; value?: string | null; children?: MdNode[] }

const TOC_OPEN_RE = /<!--\s*TOC\s*-->/i
const TOC_CLOSE_RE = /<!--\s*\/TOC\s*-->/i

/** 取 mdast 节点的纯文本（html 节点取 value，段落等容器递归拼接 text 子节点） */
function nodeText(node: MdNode): string {
  if (node.type === 'html' || node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(nodeText).join('')
}

/**
 * Milkdown 的 remark-parse 关闭了原始 HTML（allowDangerousHtml: false，安全默认），
 * `<!-- TOC -->` 在 mdast 中是"内容为注释文本的段落"而非 html 节点；
 * 外部渲染器（GitHub 等）则按 HTML 注释解析。这里按节点文本识别，两种情况都兼容。
 * 导出供单元测试覆盖（未闭合标记不吞内容等数据安全边界）。
 */
export function convertTocBlocks(node: MdNode): void {
  if (!node.children) return
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type !== 'html' && child.type !== 'paragraph') {
      convertTocBlocks(child)
      continue
    }
    const text = nodeText(child).trim()
    const openMatch = text.match(TOC_OPEN_RE)
    if (!openMatch) continue
    const openIndex = openMatch.index ?? 0
    // 开标记所在段落必须是纯标记（前后无其他内容），混有正文则不识别
    if (text.slice(0, openIndex).trim() !== '') continue

    // 结束标记在同一节点内（相邻注释被合并为一个 html 节点的情况）：
    // 整段只允许开闭标记与空白，夹带其他文字不识别
    if (TOC_CLOSE_RE.test(text)) {
      if (text.replace(TOC_OPEN_RE, '').replace(TOC_CLOSE_RE, '').trim() !== '') continue
      children.splice(i, 1, { type: 'toc' })
      continue
    }
    // 开标记后同段也不允许有正文（如 "<!-- TOC --> 说明"）
    if (text.slice(openIndex + openMatch[0].length).trim() !== '') continue

    // 向后找闭合标记（中间夹着 list 等目录链接内容）；闭标记段落同样须为纯标记
    let end = -1
    for (let j = i + 1; j < children.length; j++) {
      const sib = children[j]
      if (sib.type !== 'html' && sib.type !== 'paragraph') continue
      const sibText = nodeText(sib).trim()
      if (TOC_CLOSE_RE.test(sibText) && sibText.replace(TOC_CLOSE_RE, '').trim() === '') {
        end = j
        break
      }
    }
    // 无闭合标记：不识别、保留原文，否则会把后续正文吞进原子节点造成内容丢失
    if (end === -1) continue
    children.splice(i, end + 1 - i, { type: 'toc' })
  }
}

const tocRemark = $remark('tocRemark', () => () => (tree: unknown) => {
  convertTocBlocks(tree as MdNode)
})

// ---------------------------------------------------------------------------
// 2. 节点 schema（原子块）
// ---------------------------------------------------------------------------

const tocSchema = $nodeSchema('toc', () => ({
  group: 'block',
  atom: true,
  defining: true,
  parseDOM: [{ tag: 'div[data-type="toc"]' }],
  toDOM: () => ['div', { 'data-type': 'toc', class: 'toc-block' }],
  parseMarkdown: {
    match: ({ type }) => type === 'toc',
    runner: (state, _node, type) => {
      state.addNode(type)
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'toc',
    // 输出两行注释文本段落（remark-stringify 原样输出文本）；
    // 不能用 html 节点：Milkdown 序列化同样关闭了危险 HTML。
    // 真实链接列表由 fillTocBlocks() 在序列化后填充。
    runner: (state) => {
      // addNode 签名为 (type, children?, value?, props?)：段落须传 text 子节点数组
      state.addNode('paragraph', [{ type: 'text', value: '<!-- TOC -->' }])
      state.addNode('paragraph', [{ type: 'text', value: '<!-- /TOC -->' }])
    },
  },
}))

// ---------------------------------------------------------------------------
// 3. 锚点与标题收集（导出 HTML 与 markdown 填充共用，保证锚点一致）
// ---------------------------------------------------------------------------

/** 标题条目：级别、文本、文档位置与 GitHub 风格锚点 */
export interface TocHeading {
  level: number
  text: string
  pos: number
  slug: string
}

/** GitHub 风格锚点：小写、空白转连字符、去标点、保留中文等 Unicode 字母 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s\-\u4e00-\u9fff]/g, '')
    .replace(/\s+/g, '-')
}

/** 收集全文标题（全部级别，含同名标题的 -1/-2 计数后缀，与 GitHub 行为一致） */
export function collectHeadings(doc: ProseNode): TocHeading[] {
  const items: TocHeading[] = []
  const slugCount = new Map<string, number>()
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    const text = node.textContent
    let slug = slugify(text)
    const seen = slugCount.get(slug) ?? 0
    slugCount.set(slug, seen + 1)
    if (seen > 0) slug = `${slug}-${seen}`
    items.push({ level: node.attrs.level as number, text, pos, slug })
    return true
  })
  return items
}

/** 链接文本中的反斜杠与方括号需转义，避免破坏 [text](url) 语法 */
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1')
}

/**
 * 序列化后处理：把 toc 节点产出的空注释占位替换为真实链接列表。
 * 多个 TOC 块全部填充；文档无标题时列表为空（保留空区块）。
 */
export function fillTocBlocks(markdown: string, doc: ProseNode): string {
  const headings = collectHeadings(doc).filter((h) => h.level <= 3)
  const body = headings
    .map((h) => `${'  '.repeat(h.level - 1)}- [${escapeLinkText(h.text)}](#${h.slug})`)
    .join('\n')
  // remark-stringify 会把行首 "<!" 转义为 "\<!"（防 HTML），
  // 开闭标记前的可选反斜杠一并纳入匹配，避免残留可见的 "\"
  // 替换值用函数形式返回：body 内含标题原文，若直接传字符串，标题里的
  // $& / $` / $' 等会被 String.replace 当作替换模式解释，进而污染序列化结果
  // （本函数在保存与导出的序列化链上，污染会随写盘落到文件）
  return markdown.replace(
    /\\?<!--\s*TOC\s*-->[\s\S]*?\\?<!--\s*\/TOC\s*-->/g,
    () => `<!-- TOC -->\n\n${body}\n\n<!-- /TOC -->`,
  )
}

// ---------------------------------------------------------------------------
// 4. 节点视图：动态目录列表
// ---------------------------------------------------------------------------

/** 全部存活的 toc 视图，文档变化时统一刷新 */
const tocViews = new Set<TocView>()

/**
 * 将编辑器内指定位置滚动到滚动容器的可视区内
 *
 * ProseMirror 自带的 scrollIntoView 对自定义滚动容器（.page-scroll，
 * overflow-y: auto）不生效，因此手动定位该容器并计算滚动量。
 * 供 TOC 块与大纲面板（outline.ts）共用。
 *
 * @param view ProseMirror 视图
 * @param pos 目标文档位置（已完成选区设置）
 * @author chiangyang
 */
export function scrollEditorPosIntoView(view: EditorView, pos: number): void {
  const coords = view.coordsAtPos(pos)
  if (!coords) return
  // 从编辑器 DOM 向上找第一个内容溢出的祖先作为滚动容器
  let scroller: HTMLElement | null = view.dom.parentElement
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement
  }
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  const margin = 16
  if (coords.top < box.top + margin) {
    // 目标在可视区上方：向上滚
    scroller.scrollTop += coords.top - (box.top + margin)
  } else if (coords.bottom > box.bottom - margin) {
    // 目标在可视区下方：向下滚
    scroller.scrollTop += coords.bottom - (box.bottom - margin)
  }
}

class TocView implements NodeView {
  dom: HTMLDivElement

  private view: EditorView

  /**
   * 构造 toc 节点视图：创建目录容器 DOM，注册到全局视图集合，并按当前文档渲染一次目录
   *
   * @param _node - 对应的 ProseMirror toc 节点（原子块，内容全部动态生成，未使用）
   * @param view - 所属编辑器视图
   * @param _getPos - 获取本节点位置的函数（本视图不需要，未使用）
   */
  constructor(_node: ProseNode, view: EditorView, _getPos: () => number | undefined) {
    this.view = view
    this.dom = document.createElement('div')
    this.dom.className = 'toc-block'
    this.dom.setAttribute('data-type', 'toc')
    tocViews.add(this)
    this.refresh()
  }

  /** 按当前文档标题重建目录（由 prose 插件在 docChanged 时防抖调用） */
  refresh() {
    const items = collectHeadings(this.view.state.doc).filter((h) => h.level <= 3)
    this.dom.textContent = ''

    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'toc-empty'
      empty.textContent = t('toc.empty')
      this.dom.appendChild(empty)
      return
    }

    const list = document.createElement('div')
    list.className = 'toc-list'
    for (const item of items) {
      const row = document.createElement('div')
      row.className = `toc-item level-${item.level}`
      row.textContent = item.text || t('toc.untitledHeading')
      row.title = item.text
      row.addEventListener('click', () => this.jumpTo(item.pos))
      list.appendChild(row)
    }
    this.dom.appendChild(list)
  }

  /** 跳转到标题（与大纲面板相同的定位方式） */
  private jumpTo(pos: number) {
    const $pos = this.view.state.doc.resolve(pos + 1)
    const selection = TextSelection.near($pos, 1)
    this.view.dispatch(this.view.state.tr.setSelection(selection))
    this.view.focus()
    // 选区落位后按实际坐标滚动（不依赖 ProseMirror 的 scrollIntoView）
    scrollEditorPosIntoView(this.view, selection.from)
  }

  /**
   * ProseMirror 在节点更新时调用
   *
   * toc 是内容恒定的原子块，目录 DOM 由本视图自行维护、无需重建，
   * 仅在节点类型正确时返回 true 表示更新已自行处理。
   *
   * @param node - 更新后的节点
   * @returns true 表示无需重建视图；false 表示节点类型不符，需要重建
   */
  update(node: ProseNode): boolean {
    return node.type.name === 'toc'
  }

  /**
   * 告诉 ProseMirror 哪些 DOM 变更应被忽略，避免目录 DOM 的重建被误判为用户编辑
   *
   * 目录内的 DOM 全部自行管理，除选区变化交还 ProseMirror 外一律忽略。
   *
   * @param mutation - ProseMirror 观察到的 DOM 变更记录
   * @returns true 表示忽略该变更（不当作编辑处理）
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false
    return true
  }

  /**
   * 阻止特定 DOM 事件冒泡给 ProseMirror
   *
   * 目录行点击自行处理（跳转到标题）；块内空白处放行，允许点选节点后删除。
   *
   * @param event - 待判定的事件
   * @returns true 表示事件由本视图消费，不再交给 ProseMirror
   */
  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLElement && event.target.closest('.toc-item') !== null
  }

  /** 视图销毁：从全局视图集合移除自身，后续文档变化不再刷新本视图 */
  destroy() {
    tocViews.delete(this)
  }
}

const tocView = $view(tocSchema.node, () => (node, view, getPos) => new TocView(node, view, getPos))

// ---------------------------------------------------------------------------
// 5. prose 插件：文档变化时防抖刷新所有 toc 视图
// ---------------------------------------------------------------------------

/** 目录刷新防抖时长：合并连续输入，避免每次按键全量重建目录 DOM */
const TOC_REFRESH_DELAY_MS = 300
let refreshTimer: number | undefined

/**
 * 防抖调度一次全局目录刷新：重置未触发的定时器，TOC_REFRESH_DELAY_MS 后
 * 统一调用所有存活 toc 视图的 refresh()
 *
 * 由 tocRefresh 插件在文档内容变化时调用；计时器是模块级的，多个 toc 块
 * 共用一次刷新，连续输入不会每按一次键就全量重建目录 DOM。
 */
function scheduleTocRefresh() {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    for (const v of tocViews) v.refresh()
  }, TOC_REFRESH_DELAY_MS)
}

const tocRefresh = $prose(
  () =>
    new Plugin({
      view: () => ({
        update(view: EditorView, prevState) {
          if (view.state.doc !== prevState.doc) scheduleTocRefresh()
        },
      }),
    }),
)

// ---------------------------------------------------------------------------
// 6. 输入规则：空行输入 [TOC] 回车 → 目录块（仅顶层段落生效）
// ---------------------------------------------------------------------------

const tocInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\[toc\]$/i, (state, _match, start) => {
      const type = tocSchema.type(ctx)
      const $start = state.doc.resolve(start)
      // depth === 1：匹配位置位于顶层段落（列表项/引用内 depth 更大，不处理）
      if ($start.parent.type.name !== 'paragraph' || $start.depth !== 1) return null
      return state.tr.replaceWith($start.before(1), $start.after(1), type.create())
    }),
)

// ---------------------------------------------------------------------------
// 7. 菜单命令：在光标处插入目录块
// ---------------------------------------------------------------------------

/** 在光标处插入 toc 节点（顶层段落整段替换，其他位置拆分段落插入） */
export function insertToc(view: EditorView) {
  const type = view.state.schema.nodes['toc']
  if (!type) return
  const { $from } = view.state.selection
  const tr = view.state.tr
  if ($from.parent.type.name === 'paragraph' && $from.depth === 1) {
    tr.replaceWith($from.before(1), $from.after(1), type.create())
  } else {
    tr.replaceSelectionWith(type.create())
  }
  view.dispatch(tr)
  view.focus()
}

/** 全部 toc 相关插件，统一给编辑器 .use() */
export const tocPlugins = [tocRemark, tocSchema, tocView, tocRefresh, tocInputRule].flat()
