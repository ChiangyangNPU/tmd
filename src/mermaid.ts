/**
 * Mermaid 实时渲染插件（TMD 核心特性）
 *
 * 组成：
 * 1. remark 转换：把 markdown 里的 ```mermaid 代码块转成内部 "mermaid" 节点
 * 2. 节点 schema：可编辑文本内容的块级节点（区别于官方 diagram 插件的原子节点，
 *    这样光标可以进入源码编辑）
 * 3. 节点视图：光标不在块内时渲染 SVG；点击图表进入源码编辑；渲染失败清空旧图并显示错误信息
 * 4. 输入规则：直接输入 ```mermaid 回车即可创建图表块
 * 5. 编辑态装饰：光标位于块内时显示源码、隐藏图表（Typora 行为）
 *
 * @author chiangyang
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
  type ViewMutationRecord,
} from '@milkdown/kit/prose/view'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule, $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils'
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })

/** 初始化 mermaid 主题；已渲染图表的重渲由 reThemeMermaid 原地完成 */
export function setMermaidTheme(theme: 'default' | 'dark') {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
}

// ---------------------------------------------------------------------------
// 1. remark 转换：mdast 中 lang === 'mermaid' 的 code 节点 → type === 'mermaid'
// ---------------------------------------------------------------------------

type MdNode = { type: string; lang?: string | null; value?: string | null; children?: MdNode[] }

/**
 * 递归遍历 mdast，把 lang 为 mermaid 的 code 节点就地替换为内部 mermaid 节点
 *
 * 作为 mermaidRemark 的转换步骤，在 markdown 解析进编辑器时执行：命中即替换为
 * `{ type: 'mermaid', value }`，未命中的节点继续向下递归；无子节点的叶子直接跳过。
 *
 * @param node - 待处理的 mdast 节点（含 children 时递归其子节点，就地修改）
 */
function convertMermaidBlocks(node: MdNode): void {
  if (!node.children) return
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'code' && child.lang === 'mermaid') {
      children[i] = { type: 'mermaid', value: child.value ?? '' }
    } else {
      convertMermaidBlocks(child)
    }
  }
}

const mermaidRemark = $remark('mermaidRemark', () => () => (tree: unknown) => {
  convertMermaidBlocks(tree as MdNode)
})

// ---------------------------------------------------------------------------
// 2. 节点 schema
// ---------------------------------------------------------------------------

const mermaidSchema = $nodeSchema('mermaid', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [
    {
      tag: 'pre[data-type="mermaid"]',
      preserveWhitespace: 'full',
      getAttrs: (dom) => ({ value: dom.textContent ?? '' }),
    },
  ],
  toDOM: () => ['pre', { 'data-type': 'mermaid', class: 'mermaid-plain' }, ['code', 0]],
  parseMarkdown: {
    match: ({ type }) => type === 'mermaid',
    runner: (state, node, type) => {
      state.openNode(type)
      const value = (node as { value?: string }).value ?? ''
      if (value) state.addText(value)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mermaid',
    runner: (state, node) => {
      state.addNode('code', undefined, node.textContent || '', { lang: 'mermaid' })
    },
  },
}))

// ---------------------------------------------------------------------------
// 3. 节点视图
// ---------------------------------------------------------------------------

const RENDER_DEBOUNCE_MS = 400

/** 全部存活的 mermaid 视图，主题切换时统一原地重渲（不重建编辑器） */
const mermaidViews = new Set<MermaidView>()

/** 主题切换后重渲所有已渲染的图表（SVG 内嵌旧主题配色，必须重画） */
export function reThemeMermaid() {
  for (const v of mermaidViews) v.reTheme()
}

class MermaidView implements NodeView {
  dom: HTMLDivElement
  contentDOM: HTMLElement

  private view: EditorView
  private getPos: () => number | undefined

  private renderArea: HTMLDivElement
  private errorTip: HTMLDivElement
  private placeholder: HTMLDivElement
  private srcWrapper: HTMLPreElement

  private lastCode: string | null = null
  private renderSeq = 0
  private timer: number | undefined

  /**
   * 构造 mermaid 节点视图：创建渲染区、错误提示、占位提示与源码区 DOM，
   * 绑定渲染区点击进入源码编辑，注册到全局视图集合，并按节点源码首次调度渲染
   *
   * @param node - 对应的 ProseMirror mermaid 节点
   * @param view - 所属编辑器视图
   * @param getPos - 获取本节点在文档中位置的函数（节点已被移除时返回 undefined）
   */
  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.classList.add('mermaid-block')

    this.renderArea = document.createElement('div')
    this.renderArea.className = 'mermaid-render'
    this.renderArea.title = '点击编辑源码'

    this.errorTip = document.createElement('div')
    this.errorTip.className = 'mermaid-error'
    this.errorTip.hidden = true

    this.placeholder = document.createElement('div')
    this.placeholder.className = 'mermaid-placeholder'
    this.placeholder.textContent = 'Mermaid 图表（点击编辑源码）'
    this.placeholder.hidden = true

    this.srcWrapper = document.createElement('pre')
    this.srcWrapper.className = 'mermaid-src'
    this.contentDOM = document.createElement('code')
    this.srcWrapper.appendChild(this.contentDOM)

    this.dom.append(this.renderArea, this.errorTip, this.placeholder, this.srcWrapper)

    this.renderArea.addEventListener('click', () => this.enterEdit())
    mermaidViews.add(this)
    this.syncEditing(node)
    this.scheduleRender(node.textContent)
  }

  /** 主题切换：用当前源码重画 SVG（绕过防抖；renderSeq 守卫丢弃过期结果） */
  reTheme() {
    if (this.lastCode != null) void this.renderNow(this.lastCode)
  }

  /** 光标位于本块的内容范围内即视为编辑态（显示源码、隐藏图表） */
  private syncEditing(node: ProseNode) {
    const pos = this.getPos()
    const { from, to } = this.view.state.selection
    const editing = pos != null && from >= pos + 1 && to <= pos + node.nodeSize - 1
    this.dom.classList.toggle('editing', editing)
  }

  /**
   * 进入源码编辑（点击渲染区触发）：把选区移到本块内容起点并聚焦编辑器；
   * 编辑态装饰检测到光标落在本块内后，视图即切到源码显示
   */
  private enterEdit() {
    const pos = this.getPos()
    if (pos == null) return
    const $pos = this.view.state.doc.resolve(pos + 1)
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near($pos, 1)))
    this.view.focus()
  }

  /**
   * 防抖调度渲染：先清掉未触发的定时器，RENDER_DEBOUNCE_MS 后再真正渲染，
   * 用于合并连续输入产生的多次渲染请求
   *
   * @param code - 待渲染的 mermaid 源码
   */
  private scheduleRender(code: string) {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.renderNow(code), RENDER_DEBOUNCE_MS)
  }

  /**
   * 立即渲染：把 mermaid 源码画成 SVG 挂到渲染区（防抖到期或主题切换时调用）
   *
   * 每次渲染前递增 renderSeq 并记录源码，异步返回后序号不匹配即丢弃结果，
   * 避免过期的渲染覆盖新图；源码为空白时清空图表并显示占位提示。
   * mermaid 图表类型按需懒加载导致的 "No diagram type detected" 会在
   * retry < 3 且源码未被改动时延时重试，其他错误则清空旧图并展示错误信息。
   *
   * @param code - 待渲染的 mermaid 源码
   * @param retry - 当前重试次数，首次调用为 0
   */
  private async renderNow(code: string, retry = 0) {
    this.lastCode = code
    const seq = ++this.renderSeq

    if (!code.trim()) {
      this.renderArea.innerHTML = ''
      this.placeholder.hidden = false
      this.errorTip.hidden = true
      return
    }
    this.placeholder.hidden = true

    try {
      const id = `tmd-mermaid-${seq}-${Math.random().toString(36).slice(2, 8)}`
      const { svg } = await mermaid.render(id, code)
      if (seq !== this.renderSeq) return // 已有更新的渲染请求，丢弃过期结果
      this.renderArea.innerHTML = svg
      this.errorTip.hidden = true
    } catch (err) {
      if (seq !== this.renderSeq) return
      const message = err instanceof Error ? err.message : String(err)
      // mermaid 图表类型按需懒加载：冷启动立刻渲染会因模块未就绪而报
      // "No diagram type detected"，短暂等待后重试即可恢复
      if (retry < 3 && message.includes('No diagram type detected')) {
        window.setTimeout(
          () => {
            if (seq === this.renderSeq && this.lastCode === code)
              void this.renderNow(code, retry + 1)
          },
          400 * (retry + 1),
        )
        return
      }
      // 语法错误时清空旧图并显示错误信息（与 Typora/Obsidian 行为一致，
      // 避免用户误以为旧图是当前语法的渲染结果）
      this.renderArea.innerHTML = ''
      this.errorTip.textContent = `Mermaid 语法有误：${message}`
      this.errorTip.hidden = false
    }
  }

  /**
   * ProseMirror 在节点（或装饰）更新时调用
   *
   * 节点类型不符时返回 false 让 ProseMirror 重建视图；否则同步一次编辑态，
   * 并在源码文本变化时防抖重渲。
   *
   * @param node - 更新后的节点
   * @param _decorations - 本次生效的装饰集（本视图不依赖，未使用）
   * @returns true 表示更新已由本视图自行处理（无需重建）；false 表示需要重建视图
   */
  update(node: ProseNode, _decorations: readonly Decoration[]): boolean {
    if (node.type.name !== 'mermaid') return false
    this.syncEditing(node)
    if (node.textContent !== this.lastCode) this.scheduleRender(node.textContent)
    return true
  }

  /**
   * 告诉 ProseMirror 哪些 DOM 变更应被忽略，避免内部渲染操作被误判为用户编辑
   *
   * 自己改动的 SVG 区域不需要交给 ProseMirror 处理；源码区的文本变更必须交还，
   * 选区变化一律交还。
   *
   * @param mutation - ProseMirror 观察到的 DOM 变更记录
   * @returns true 表示忽略该变更（不当作编辑处理）
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false
    return !this.contentDOM.contains(mutation.target)
  }

  /**
   * 阻止特定 DOM 事件冒泡给 ProseMirror
   *
   * 图表区域的鼠标事件自行处理（点击进入编辑），源码区的事件照常交给编辑器。
   *
   * @param event - 待判定的事件
   * @returns true 表示事件由本视图消费，不再交给 ProseMirror
   */
  stopEvent(event: Event): boolean {
    return this.renderArea.contains(event.target as Node)
  }

  /** 视图销毁：清理未触发的渲染定时器，并从全局视图集合移除自身 */
  destroy() {
    window.clearTimeout(this.timer)
    mermaidViews.delete(this)
  }
}

const mermaidView = $view(
  mermaidSchema.node,
  () => (node, view, getPos) => new MermaidView(node, view, getPos),
)

// ---------------------------------------------------------------------------
// 4. 输入规则：输入 ```mermaid 立即转为图表块
// ---------------------------------------------------------------------------

const mermaidInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^```mermaid$/, (state, _match, start, end) => {
      const nodeType = mermaidSchema.type(ctx)
      return state.tr.delete(start, end).setBlockType(start, start, nodeType)
    }),
)

// ---------------------------------------------------------------------------
// 5. 编辑态装饰：光标在 mermaid 块内 → 打上 editing 标记（节点视图据此显示源码）
// ---------------------------------------------------------------------------

const mermaidEditingDecoration = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (state) => {
          const decos: Decoration[] = []
          state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
            if (node.type.name === 'mermaid') {
              decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'editing' }))
            }
          })
          return DecorationSet.create(state.doc, decos)
        },
      },
    }),
)

/** 全部 mermaid 相关插件，统一给编辑器 .use() */
export const mermaidPlugins = [
  mermaidRemark,
  mermaidSchema,
  mermaidView,
  mermaidInputRule,
  mermaidEditingDecoration,
].flat()
