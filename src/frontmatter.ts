/**
 * YAML front matter（文档元信息）块插件
 *
 * 功能：文档起始的 --- 围栏元信息块在所见即所得中渲染为「属性表」
 * （键值行），点击属性区或「编辑」按钮切换为 YAML 文本编辑；
 * 保存时围栏块字节级原样写回（仅由 remark 规范化整块之后的单个尾换行，
 * 与全文其他块一致），导出 HTML/PDF 时整块剥离（见 export.ts）。
 *
 * 存储格式（Markdown 文本）：
 *   ---
 *   title: 标题
 *   tags:
 *     - 随感
 *   ---
 *   正文……
 *
 * 字节级往返的实现关键：
 * - remark-frontmatter 让 micromark 把围栏识别为 mdast yaml 节点（避免起始
 *   --- 被降级为 setext 下划线/分隔线）；
 * - transform 阶段依据 position 从源码切出「围栏起到下一块前」的完整原文
 *   （含中间空行），存进 ProseMirror 原子块 attrs.value；
 * - 序列化时自定义 handler 原样吐出 value，并注册 join 规则不在其后补空行
 *   （切片已含原始间隔，handler 仅去掉尾 LF，join 补回即复原 LF/CRLF）。
 *
 * 组成（与 toc.ts / mermaid.ts 同构）：
 * 1. remark：remark-frontmatter + yaml→frontmatter 转换 + 序列化 handler/join
 * 2. 节点 schema：原子块（attrs.value 存围栏原文）
 * 3. 节点视图：属性表 / YAML 文本双态
 * 4. 输入规则：文档首个空段落输入 --- 即创建并进入编辑态
 *
 * @author chiangyang
 */
import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule, $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import remarkFrontmatter from 'remark-frontmatter'
import { t } from './i18n'

// ---------------------------------------------------------------------------
// 1. 纯函数层：属性表解析、围栏校验、mdast 转换（均导出供单测）
// ---------------------------------------------------------------------------

/** 内部最小 mdast 节点结构（与 toc.ts/mark-ext.ts 同风格） */
export interface FmMdNode {
  type: string
  value?: string
  children?: FmMdNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

/** 新创建空 front matter 的初始内容（属性表为空时据此自动进入编辑态） */
export const EMPTY_FRONTMATTER = '---\n\n---'

/** 属性表解析结果 */
export interface FmProps {
  /** 可识别的顶层简单键值（key: value） */
  entries: Array<{ key: string; value: string }>
  /** 含数组/多行缩进等属性表不展开的结构（仍可在 YAML 文本中编辑） */
  complex: boolean
  /** 存在无法识别的顶层行（语法不完整） */
  invalid: boolean
}

/** 去掉成对包裹的单/双引号（不成对则原样返回） */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 解析 front matter 原文为属性表数据（轻量解析，零依赖）：
 * - 仅展开顶层「key: value」简单行；引号成对时去引号；空值合法；
 * - 顶层数组项（- x）与缩进续行标记为 complex（不逐个展开）；
 * - 注释行/空行跳过；其余顶层行标记 invalid；
 * - 围栏缺失或未闭合整体 invalid（调用方据此提示并保留原文）。
 */
export function parseFrontMatterProps(raw: string): FmProps {
  const lines = raw.split(/\r?\n/)
  const result: FmProps = { entries: [], complex: false, invalid: false }
  if (lines[0]?.trim() !== '---') {
    result.invalid = true
    return result
  }
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '---' || trimmed === '...') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    result.invalid = true
    return result
  }
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    // 缩进内容：多行值或数组元素的续行
    if (/^\s/.test(line)) {
      result.complex = true
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+):[ \t]?(.*)$/.exec(line)
    if (kv) {
      result.entries.push({ key: kv[1], value: unquote(kv[2].trim()) })
      continue
    }
    // 顶层数组项（如文档级序列）
    if (/^-(?:[ \t]|$)/.test(line)) {
      result.complex = true
      continue
    }
    result.invalid = true
  }
  return result
}

/** 围栏形态校验：首行 ---，其后存在闭合行（--- 或 YAML 的 ...） */
export function validateFrontMatter(raw: string): boolean {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return false
  return lines.slice(1).some((line) => line.trim() === '---' || line.trim() === '...')
}

/**
 * 从源码切出 front matter 块原文：
 * 起点为 yaml 节点起点，终点为「下一个兄弟节点起点」（无下一块则到源码末），
 * 完整保留围栏与正文之间的原始空行；末尾仅去掉一个 LF（CRLF 时保留 CR），
 * 序列化时 join 规则补回一个 LF，恰好复原原行尾（LF/CRLF 皆字节一致）。
 * 源码不可用或缺少 position 时退化为标准围栏拼接。
 */
function extractRaw(node: FmMdNode, next: FmMdNode | undefined, source?: string): string {
  const fallback = () => `---\n${node.value ?? ''}\n---`
  if (!source) return fallback()
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return fallback()
  const nextStart = next?.position?.start.offset ?? source.length
  return source.slice(start, Math.max(end, nextStart)).replace(/\n$/, '')
}

/**
 * mdast transform：把 remark-frontmatter 产生的 yaml 节点替换为自定义
 * frontmatter 字面节点（value 为围栏原文）。front matter 只可能出现在
 * 文档起始（micromark 保证），正文中间的 --- 不受影响。
 */
export function convertFrontMatter(tree: FmMdNode, source?: string): void {
  const children = tree.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type !== 'yaml') continue
    children[i] = {
      type: 'frontmatter',
      value: extractRaw(node, children[i + 1], source),
      // 保留 position 供管线其他环节使用
      position: node.position,
    }
  }
}

// ---------------------------------------------------------------------------
// 2. remark attacher：frontmatter 解析 + 原样往返序列化
// ---------------------------------------------------------------------------

/**
 * 统一的 remark 插件（unified 裸插件，导出供单测做 parse→stringify 往返）：
 * - attacher 阶段委托 remark-frontmatter 注册 micromark/from/toMarkdown 扩展
 *   （yaml 类型的默认解析与序列化）；
 * - 再注册自定义 frontmatter 类型的 handler（原样输出）与 join 规则
 *   （frontmatter 与其后块之间不额外加空行，间隔已含在原文切片里）；
 * - transform 阶段把 yaml 节点转为带原文的 frontmatter 节点。
 */
export const frontmatterPlugin: Plugin<[], Root> = function () {
  // 注册 remark-frontmatter 的三套扩展到当前 processor（this 同为 unified processor）
  remarkFrontmatter.call(this)

  // vfile Data 类型只声明已知字段，扩展字段经字符串键动态读写
  const data = this.data() as Record<string, unknown>
  const extensions = (data.toMarkdownExtensions as unknown[] | undefined) ?? []
  extensions.push({
    handlers: {
      frontmatter: (node: { value?: string }) => node.value ?? '',
    },
    // join 是函数数组：返回 0 → 块间恰好 1 个换行（无空行）；
    // 原始空行已包含在 value 尾部，CRLF 的 CR 也保留在 value 末尾
    join: [(left: { type: string }) => (left.type === 'frontmatter' ? 0 : undefined)],
  })
  data.toMarkdownExtensions = extensions

  return (tree: Root, file) =>
    convertFrontMatter(tree as FmMdNode, typeof file.value === 'string' ? file.value : undefined)
}

const frontmatterRemark = $remark('tmdFrontmatter', () => frontmatterPlugin)

// ---------------------------------------------------------------------------
// 3. 节点 schema：原子块
// ---------------------------------------------------------------------------

const frontmatterSchema = $nodeSchema('frontmatter', () => ({
  group: 'block',
  atom: true,
  defining: true,
  attrs: {
    value: { default: EMPTY_FRONTMATTER },
    // 仅输入规则刚创建的块为 true：创建后自动进编辑态；
    // 提交时 setNodeMarkup 回落为 false。不参与 DOM/Markdown 序列化，
    // 因此不能用 value === EMPTY_FRONTMATTER 判别（空内容提交会再次误入编辑态）
    fresh: { default: false },
  },
  parseDOM: [
    {
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? EMPTY_FRONTMATTER,
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'frontmatter',
      'data-value': node.attrs.value as string,
      class: 'fm-block',
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === 'frontmatter',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value ?? '') as string })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    // addNode(type, children?, value?, props?)：字面节点第二参 children 留空
    runner: (state, node) => {
      state.addNode('frontmatter', undefined, node.attrs.value as string)
    },
  },
}))

// ---------------------------------------------------------------------------
// 4. 节点视图：属性表 / YAML 文本双态
// ---------------------------------------------------------------------------

class FrontMatterView implements NodeView {
  dom: HTMLDivElement

  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private editing: boolean

  /**
   * 构造 front matter 节点视图：记录节点、编辑器视图与位置获取函数，按
   * attrs.fresh 决定初始状态，并渲染出内部 DOM
   *
   * 本视图承担「键值属性表 ⇄ YAML 源码」双态切换：属性表态解析 value 展示
   * 键值行，编辑态提供 textarea 直接编辑围栏原文。
   *
   * @param node - 对应的 ProseMirror frontmatter 节点（attrs.value 存围栏原文）
   * @param view - 所属编辑器视图
   * @param getPos - 获取本节点在文档中位置的函数（节点已被移除时返回 undefined）
   */
  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    // 输入规则新建的空块直接进入编辑态；从文件解析/提交后的块展示属性表
    this.editing = node.attrs.fresh === true
    this.dom = document.createElement('div')
    this.dom.className = 'fm-block'
    this.dom.setAttribute('data-type', 'frontmatter')
    this.render()
  }

  /** 按当前状态重建内部 DOM（外壳 div 与 NodeView 身份保持不变） */
  private render() {
    this.dom.textContent = ''
    this.dom.classList.toggle('fm-editing', this.editing)
    this.dom.appendChild(this.editing ? this.buildEditor() : this.buildProps())
  }

  /**
   * 构建属性表与编辑态共用的头部：左侧为 YAML 标识徽章，右侧为按钮容器
   *
   * @param actions - 依次放入头部右侧的按钮元素
   * @returns 头部 DOM 元素（.fm-head）
   */
  private buildHead(actions: HTMLElement[]): HTMLElement {
    const head = document.createElement('div')
    head.className = 'fm-head'
    const badge = document.createElement('span')
    badge.className = 'fm-badge'
    badge.textContent = 'YAML'
    head.appendChild(badge)
    const wrap = document.createElement('div')
    wrap.className = 'fm-head-actions'
    for (const action of actions) wrap.appendChild(action)
    head.appendChild(wrap)
    return head
  }

  /**
   * 创建块内操作按钮，点击事件在内部消化（阻止冒泡，避免触发编辑器的选区/节点行为）
   *
   * @param text - 按钮文案
   * @param primary - 是否主按钮（附加 primary 样式类）
   * @param onClick - 点击回调
   * @returns 按钮元素（.fm-btn）
   */
  private makeButton(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `fm-btn${primary ? ' primary' : ''}`
    btn.textContent = text
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return btn
  }

  /** 属性表态：头部（标识 + 编辑入口）与键值区 */
  private buildProps(): HTMLElement {
    const frag = document.createDocumentFragment()
    const editBtn = this.makeButton(t('frontmatter.edit'), false, () => this.enterEditing())
    frag.appendChild(this.buildHead([editBtn]))

    const body = document.createElement('div')
    body.className = 'fm-body'
    // 点击键值区任意位置即切换为 YAML 文本编辑
    body.addEventListener('click', () => this.enterEditing())

    const props = parseFrontMatterProps(this.node.attrs.value as string)
    for (const { key, value } of props.entries) {
      const row = document.createElement('div')
      row.className = 'fm-row'
      const k = document.createElement('span')
      k.className = 'fm-key'
      k.textContent = key
      const v = document.createElement('span')
      v.className = 'fm-val'
      v.textContent = value || '""'
      row.append(k, v)
      body.appendChild(row)
    }
    if (props.entries.length === 0) {
      body.appendChild(this.hint('fm-hint', t('frontmatter.empty')))
    }
    if (props.complex) {
      body.appendChild(this.hint('fm-hint', t('frontmatter.complex')))
    }
    if (props.invalid) {
      body.appendChild(this.hint('fm-hint fm-invalid', t('frontmatter.invalid')))
    }
    frag.appendChild(body)

    const wrap = document.createElement('div')
    wrap.className = 'fm-canvas'
    wrap.appendChild(frag)
    return wrap
  }

  /**
   * 创建提示行元素（属性区底部的空块/复杂结构/非法 YAML 提示）
   *
   * @param className - 提示行的样式类名
   * @param text - 提示文案
   * @returns 提示 DOM 元素
   */
  private hint(className: string, text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = className
    el.textContent = text
    return el
  }

  /** 编辑态：头部（完成/取消）+ textarea + 错误提示行 */
  private buildEditor(): HTMLElement {
    const value = this.node.attrs.value as string
    const saveBtn = this.makeButton(t('frontmatter.save'), true, () => this.commit())
    const cancelBtn = this.makeButton(t('frontmatter.cancel'), false, () => this.cancel())
    const head = this.buildHead([saveBtn, cancelBtn])

    const textarea = document.createElement('textarea')
    textarea.className = 'fm-input'
    textarea.spellcheck = false
    textarea.value = value
    textarea.rows = Math.max(4, value.split('\n').length)
    textarea.setAttribute('aria-label', 'YAML front matter')
    textarea.addEventListener('keydown', (e) => {
      // 编辑态全部按键自行消化（stopEvent 已拦截，这里做快捷键）
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        this.commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancel()
      } else if (e.key === 'Tab') {
        // 在原位插入两个空格，避免焦点跳出编辑区
        e.preventDefault()
        const pos = textarea.selectionStart
        textarea.setRangeText('  ', pos, textarea.selectionEnd, 'end')
      }
    })

    const error = document.createElement('div')
    error.className = 'fm-error'
    error.hidden = true
    error.textContent = t('frontmatter.invalid')

    const wrap = document.createElement('div')
    wrap.className = 'fm-canvas'
    wrap.append(head, textarea, error)
    // 等 DOM 挂载后再聚焦（NodeView 创建时元素尚未入文档）
    queueMicrotask(() => textarea.focus())
    return wrap
  }

  /** 进入 YAML 源码编辑态：重建内部 DOM 并聚焦输入框（已在编辑态则直接返回） */
  private enterEditing() {
    if (this.editing) return
    this.editing = true
    this.render()
    this.dom.querySelector('textarea')?.focus()
  }

  /**
   * 提交编辑：去掉输入末尾的空行后校验围栏是否成对合法，通过则退出编辑态并把
   * 新原文写回节点属性（触发一次文档事务）
   *
   * 校验失败时显示错误提示并保持焦点停留在输入框，不写回节点、不退出编辑态，
   * 原输入内容原样保留。
   */
  private commit() {
    const textarea = this.dom.querySelector('textarea')
    const raw = (textarea?.value ?? '').replace(/(\r?\n)+$/, '')
    const error = this.dom.querySelector('.fm-error') as HTMLElement | null
    if (!validateFrontMatter(raw)) {
      if (error) error.hidden = false
      textarea?.focus()
      return
    }
    const pos = this.getPos()
    if (typeof pos !== 'number') return
    this.editing = false
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { value: raw }))
    this.view.focus()
  }

  /** 取消编辑：丢弃输入内容，回到属性表展示并让编辑器重获焦点 */
  private cancel() {
    this.editing = false
    this.render()
    this.view.focus()
  }

  /**
   * ProseMirror 在节点更新时调用
   *
   * 节点类型不符时返回 false 让 ProseMirror 重建视图；类型正确时刷新节点引用，
   * 编辑态中不重渲染以免外部事务（协同/撤销）打断输入，其余情况刷新属性表。
   *
   * @param node - 更新后的节点
   * @returns true 表示更新已由本视图自行处理（无需重建）；false 表示需要重建视图
   */
  update(node: ProseNode): boolean {
    if (node.type.name !== 'frontmatter') return false
    this.node = node
    // 编辑态中外部事务（如协同/撤销）不打断输入；其余情况刷新属性表
    if (!this.editing) this.render()
    return true
  }

  /**
   * 告诉 ProseMirror 哪些 DOM 变更应被忽略，避免内部渲染被误判为用户编辑
   *
   * 内部 DOM 全部自行管理，不交给 ProseMirror；仅选区变化交还处理。
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
   * 编辑态拦截全部事件（textarea 输入、按钮、快捷键均不落入编辑器）；
   * 属性表态仅拦截键值区点击（进编辑）与头部按钮，头部空白放行以点选删除节点。
   *
   * @param event - 待判定的事件
   * @returns true 表示事件由本视图消费，不再交给 ProseMirror
   */
  stopEvent(event: Event): boolean {
    if (this.editing) return true
    if (!(event.target instanceof HTMLElement)) return false
    return event.target.closest('.fm-body, .fm-btn') !== null
  }
}

const frontmatterView = $view(
  frontmatterSchema.node,
  () => (node, view, getPos) => new FrontMatterView(node, view, getPos),
)

// ---------------------------------------------------------------------------
// 5. 输入规则：文档首个空段落输入 --- → front matter 块
// ---------------------------------------------------------------------------

// 单独导出：必须先于 commonmark 注册（--- 要抢在水平线输入规则之前）。
// 规则工厂里的 schema 类型经 ctx 延迟到按键时解析，故插件本身提前注册不依赖
// schema 注册顺序；但 schema/remark/view 不能跟着提前——frontmatter 是
// group:'block' 节点，若先于 paragraph 注册，空文档自动补块（fillBefore）会
// 误选 frontmatter 作为第一个 block 节点
export const frontmatterInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^---$/, (state, _match, start) => {
      const $start = state.doc.resolve(start)
      // depth === 1 顶层段落；before(1) === 0 即文档第一个块（之后的 --- 仍走水平线）
      if ($start.parent.type.name !== 'paragraph' || $start.depth !== 1) return null
      if ($start.before(1) !== 0) return null
      const type = frontmatterSchema.type(ctx)
      return state.tr.replaceWith(
        $start.before(1),
        $start.after(1),
        type.create({ value: EMPTY_FRONTMATTER, fresh: true }),
      )
    }),
)

/**
 * front matter 的 schema/remark/view 插件（位置在 commonmark 之后）。
 * 输入规则见 frontmatterInputRule（需单独最先注册）
 */
export const frontmatterPlugins = [frontmatterRemark, frontmatterSchema, frontmatterView].flat()
