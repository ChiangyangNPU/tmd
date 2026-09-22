/**
 * 图片缩放 / 对齐插件
 *
 * 功能：为 image 节点扩展 width（像素宽）、align（对齐）、zoom（Typora 缩放比）
 * 三个属性；编辑器内点击图片出现右下角拖拽缩放手柄与对齐浮层（左/中/右/重置）。
 *
 * 存储格式（Markdown 文本，Typora 同款）：
 *   无属性：![alt](src "title") —— 与原生语法零差异，旧文档无损
 *   有属性：<img src="..." alt="..." width="300" align="center">
 *   Typora 缩放：<img src="..." style="zoom:50%"> —— 原样往返（zoom 不折算，
 *   折算需要异步取 naturalWidth 且不可逆）
 *
 * 设计要点：
 * 1. remark 阶段把 mdast 中 <img> html 节点转换为 image 节点（属性挂 data），
 *    否则会被 preset 的 htmlSchema 吞成纯文本节点
 * 2. 序列化反向走 mdast html 节点——remark-stringify 对 html 节点逐字输出
 *    （本仓库实测 remark-parse 15 / remark-stringify 10）
 * 3. image-resolver 的 file:// 解析是节点装饰，打到 NodeView 外层 dom，
 *    ImageView 在 update 里自行读取装饰并施加到内层 img
 *
 * 组成（与 mermaid.ts / toc.ts 同构）：
 * 1. 纯函数：serializeImgHtml / parseImgHtml / transformImgHtmlNodes（全部可单测）
 * 2. schema 扩展：imageSchema.extendSchema 新增 attrs 与双向序列化
 * 3. 节点视图：ImageView（选中态手柄与浮层、拖拽缩放、对齐动作）
 *
 * @author chiangyang
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { Decoration, EditorView, NodeView } from '@milkdown/kit/prose/view'
import { $remark, $view } from '@milkdown/kit/utils'
import { expectDomTypeError } from '@milkdown/kit/exception'
import { imageAttr, imageSchema } from '@milkdown/kit/preset/commonmark'
import { t } from './i18n'
import { isSafeImageSrc } from './paste-html'

// ---------------------------------------------------------------------------
// 1. 纯函数：HTML img 标签的序列化与解析
// ---------------------------------------------------------------------------

export type ImageAlign = '' | 'left' | 'center' | 'right'

/** 图片属性（ProseMirror attrs 与解析结果共用的形状） */
export interface ImgAttrs {
  src: string
  alt: string | null
  title: string | null
  width: number | null
  align: ImageAlign
  zoom: number | null
}

/** 宽度钳制范围：下限保证可点中，上限防溢出 */
const MIN_WIDTH = 32
const MAX_WIDTH = 99999

/**
 * 宽度裁剪：先四舍五入取整，再夹到 [MIN_WIDTH, MAX_WIDTH] 区间
 *
 * 边界取自模块常量：下限 MIN_WIDTH（32px）保证缩放手柄仍可点中，
 * 上限 MAX_WIDTH（99999px）防止宽度溢出；拖拽时调用方还会再叠加一次
 * 编辑器可用宽度的限制。
 *
 * @param w - 待裁剪的宽度（像素）
 * @returns 取整并夹在上下限之内的宽度
 */
export function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))
}

/** style 属性中的 zoom 声明（兼容 "zoom:50%" 与无单位 "zoom:0.5" 两种 CSS 写法） */
const ZOOM_RE = /(?:^|;)\s*zoom\s*:\s*([\d.]+)\s*(%?)\s*(?:;|$)/i

/** 解析 style 中的 zoom 百分比（归一为 1..1000 的数值），无则 null */
export function parseZoom(style: string): number | null {
  const m = style.match(ZOOM_RE)
  if (!m) return null
  const raw = Number.parseFloat(m[1])
  if (!Number.isFinite(raw)) return null
  const pct = m[2] === '%' ? raw : raw * 100
  if (pct < 1 || pct > 1000) return null
  return Math.round(pct * 10) / 10
}

/** 拼接 img 内联样式（width 像素 + zoom 百分比），无则空串 */
export function imgInlineStyle(width: number | null, zoom: number | null): string {
  const parts: string[] = []
  if (width != null) parts.push(`width:${width}px`)
  if (zoom != null) parts.push(`zoom:${zoom}%`)
  return parts.join(';')
}

/** HTML 属性值转义 */
function escapeHtmlAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 序列化为 <img ...> 标签；无任何缩放/对齐属性时返回 null
 * （调用方回落到原生 ![alt](src) 语法，保证无属性文档零变化）
 */
export function serializeImgHtml(a: ImgAttrs): string | null {
  if (!a.src) return null
  if (a.width == null && a.zoom == null && !a.align) return null
  const parts = [`src="${escapeHtmlAttr(a.src)}"`]
  if (a.alt) parts.push(`alt="${escapeHtmlAttr(a.alt)}"`)
  if (a.title) parts.push(`title="${escapeHtmlAttr(a.title)}"`)
  if (a.width != null) parts.push(`width="${a.width}"`)
  if (a.align) parts.push(`align="${a.align}"`)
  if (a.zoom != null) parts.push(`style="zoom:${a.zoom}%"`)
  return `<img ${parts.join(' ')}>`
}

/** 属性定义（name="value" / name='value' / name=value 三种 HTML 写法） */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

/** img 标签整体预检：限制为单标签、属性值不含 `>`，不达标的串不进解析 */
const IMG_TAG_RE = /^\s*<img\s[^<>]*\/?>\s*$/i

/** 反解常用 HTML 实体（Typora 写出的属性值可能含 &amp; 等转义） */
function decodeAttr(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * 解析 <img ...> 标签为图片属性；非 img 标签 / 不安全 src / 无缩放对齐属性
 * 返回 null（保持既有行为，不做转换）。width 仅接受整数像素（"50%" 忽略）。
 *
 * 用受控正则而非 DOMParser：标签形状已被 IMG_TAG_RE 预检收窄，
 * 且让核心逻辑保持无 DOM 依赖（vitest node 环境可直接单测）。
 */
export function parseImgHtml(html: string): ImgAttrs | null {
  if (!IMG_TAG_RE.test(html)) return null
  const attrs: Record<string, string> = {}
  for (const m of html.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? m[4] ?? '')
  }
  const src = (attrs.src ?? '').trim()
  if (!src || !isSafeImageSrc(src)) return null

  const widthRaw = (attrs.width ?? '').trim()
  const width = /^\d+$/.test(widthRaw) ? clampWidth(Number.parseInt(widthRaw, 10)) : null
  const alignRaw = (attrs.align ?? '').toLowerCase()
  const align: ImageAlign =
    alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right' ? alignRaw : ''
  const zoom = parseZoom(attrs.style ?? '')
  if (width == null && !align && zoom == null) return null

  return { src, alt: attrs.alt ?? '', title: attrs.title ?? '', width, align, zoom }
}

// ---------------------------------------------------------------------------
// 2. remark 转换：mdast 中的 <img> html 节点 → image 节点（属性挂 data）
// ---------------------------------------------------------------------------

type MdNode = {
  type: string
  value?: string | null
  children?: MdNode[]
  url?: string
  alt?: string | null
  title?: string | null
  data?: Record<string, unknown>
}

/** 直接子节点为 flow 层的容器（<img> 独占一行会落在这些位置） */
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem'])

/**
 * 遍历 mdast，把命中 parseImgHtml 的 html 节点替换为 image 节点：
 * 行内位置（段落/标题等内）原位替换；flow 层（root/blockquote/listItem 直接子级）
 * 包一层 paragraph（remark 的 root 等容器不收 inline 节点）。
 * 非 img / 解析失败不动，TOC 注释等原样保留。
 * 导出供单元测试覆盖。
 */
export function transformImgHtmlNodes(node: MdNode): void {
  if (!node.children) return
  const flow = FLOW_PARENTS.has(node.type)
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'html') {
      const attrs = child.value ? parseImgHtml(child.value) : null
      if (attrs) {
        const image: MdNode = {
          type: 'image',
          url: attrs.src,
          alt: attrs.alt,
          title: attrs.title || null,
        }
        const data: Record<string, unknown> = {}
        if (attrs.width != null) data.width = attrs.width
        if (attrs.align) data.align = attrs.align
        if (attrs.zoom != null) data.zoom = attrs.zoom
        if (Object.keys(data).length > 0) image.data = data
        children.splice(i, 1, flow ? { type: 'paragraph', children: [image] } : image)
        continue
      }
    }
    transformImgHtmlNodes(child)
  }
}

/** remark 插件：mdast 层完成 <img> 标签到 image 节点的转换 */
export const imgAttrsRemark = $remark('imgAttrsRemark', () => () => (tree: unknown) => {
  transformImgHtmlNodes(tree as MdNode)
})

// ---------------------------------------------------------------------------
// 3. schema 扩展：image 节点新增 width/align/zoom 与双向序列化
// ---------------------------------------------------------------------------

type ImageAttrsRecord = {
  src: string
  alt: string
  title: string
  width: number | null
  align: ImageAlign
  zoom: number | null
}

/** imageSchema 扩展：必须晚于 commonmark 注册（同名 schema 后者覆盖，见 @milkdown/utils upsertById） */
export const imageSchemaExt = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: {
      ...base.attrs,
      width: { default: null },
      align: { default: '' },
      zoom: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom)
          const widthRaw = (dom.getAttribute('width') ?? '').trim()
          const alignRaw = (dom.getAttribute('align') ?? '').toLowerCase()
          return {
            src: dom.getAttribute('src') ?? '',
            alt: dom.getAttribute('alt') ?? '',
            title: dom.getAttribute('title') ?? dom.getAttribute('alt') ?? '',
            width: /^\d+$/.test(widthRaw) ? clampWidth(Number.parseInt(widthRaw, 10)) : null,
            align:
              alignRaw === 'left' || alignRaw === 'center' || alignRaw === 'right' ? alignRaw : '',
            zoom: parseZoom(dom.getAttribute('style') ?? ''),
          }
        },
      },
    ],
    toDOM: (node) => {
      const { src, alt, title, width, zoom } = node.attrs as ImageAttrsRecord
      const style = imgInlineStyle(width, zoom)
      return [
        'img',
        {
          ...ctx.get(imageAttr.key)(node),
          src,
          alt,
          title,
          ...(style ? { style } : {}),
        },
      ]
    },
    parseMarkdown: {
      match: ({ type }) => type === 'image',
      runner: (state, node, type) => {
        const data = (node.data ?? {}) as { width?: unknown; align?: unknown; zoom?: unknown }
        state.addNode(type, {
          src: node.url,
          alt: node.alt,
          title: node.title,
          width: typeof data.width === 'number' ? clampWidth(data.width) : null,
          align:
            data.align === 'left' || data.align === 'center' || data.align === 'right'
              ? data.align
              : '',
          zoom: typeof data.zoom === 'number' ? data.zoom : null,
        })
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image',
      runner: (state, node) => {
        const attrs = node.attrs as ImageAttrsRecord
        const html = serializeImgHtml(attrs)
        if (html) {
          // 有缩放/对齐属性：输出 <img ...> html 节点（remark-stringify 逐字输出）
          state.addNode('html', undefined, html)
        } else {
          // 无属性：原生 image 语法，与预设行为一致（零变化）
          state.addNode('image', undefined, undefined, {
            title: attrs.title,
            url: attrs.src,
            alt: attrs.alt,
          })
        }
      },
    },
  }
})

// ---------------------------------------------------------------------------
// 4. 节点视图：缩放手柄 + 对齐浮层
// ---------------------------------------------------------------------------

/** 对齐/重置动作的内联 SVG 图标 */
const ACTION_ICONS: Record<string, string> = {
  left: '<svg viewBox="0 0 12 12"><path d="M1.5 2.5h9M1.5 6h5M1.5 9.5h9"/></svg>',
  center: '<svg viewBox="0 0 12 12"><path d="M1.5 2.5h9M3.5 6h5M1.5 9.5h9"/></svg>',
  right: '<svg viewBox="0 0 12 12"><path d="M1.5 2.5h9M5.5 6h5M1.5 9.5h9"/></svg>',
  reset: '<svg viewBox="0 0 12 12"><path d="M2.5 6a3.5 3.5 0 1 1 1 2.5M2.5 9V6.5H5"/></svg>',
}

class ImageView implements NodeView {
  dom: HTMLElement

  private view: EditorView
  private node: ProseNode
  private getPos: () => number | undefined

  private img: HTMLImageElement
  private toolbar: HTMLDivElement
  private handle: HTMLElement

  private cleanupDrag: (() => void) | null = null

  /**
   * 构造图片节点视图：依次创建 img、对齐/重置工具栏与缩放手柄，装入 span 容器，
   * 绑定工具栏按压（阻止失选）、按钮点击与手柄拖拽，最后按节点属性同步一次 DOM
   *
   * 本视图承担「图片 + 对齐/重置操作 + 拖拽缩放」的展示与交互；拖拽过程中只做
   * DOM 预览，抬起鼠标才一次性提交文档事务。
   *
   * @param node - 对应的 ProseMirror image 节点
   * @param view - 所属编辑器视图
   * @param getPos - 获取本节点在文档中位置的函数（节点已被移除时返回 undefined）
   * @param decorations - 构造时作用于本节点的外部装饰（image-resolver 解析出的
   *                      file:// src）。ProseMirror 仅在构造期以该参数下发初始装饰，
   *                      后续更新走 update(node, decorations)；漏传会导致首帧 src
   *                      仍是文档内相对路径，图片加载失败，直到点击等操作触发 update
   */
  constructor(
    node: ProseNode,
    view: EditorView,
    getPos: () => number | undefined,
    decorations: readonly Decoration[] = [],
  ) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('span')
    this.dom.className = 'pm-image'

    this.img = document.createElement('img')

    this.toolbar = document.createElement('div')
    this.toolbar.className = 'pm-image-toolbar'
    for (const action of ['left', 'center', 'right', 'reset'] as const) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pm-image-btn'
      btn.dataset.action = action
      btn.title = t(`image.align${action[0].toUpperCase()}${action.slice(1)}`)
      btn.innerHTML = ACTION_ICONS[action]
      this.toolbar.appendChild(btn)
    }

    this.handle = document.createElement('span')
    this.handle.className = 'pm-image-handle'

    this.dom.append(this.img, this.toolbar, this.handle)

    // 工具栏按下不改变选区（否则点击按钮前图片先失选）
    this.toolbar.addEventListener('mousedown', (e) => e.preventDefault())
    this.toolbar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pm-image-btn')
      if (btn) this.applyAction(btn.dataset.action as 'left' | 'center' | 'right' | 'reset')
    })
    this.handle.addEventListener('mousedown', (e) => this.startDrag(e))

    this.apply(node, decorations)
  }

  /** 同步 attrs 与解析装饰到 DOM（image-resolver 的 file:// src 在节点装饰上） */
  private apply(node: ProseNode, decorations: readonly Decoration[]) {
    const attrs = node.attrs as ImageAttrsRecord
    let src = attrs.src
    for (const deco of decorations) {
      // PM 的 Decoration 抽象类未声明 type 字段（子类才有），按节点装饰的形状读取
      const decoType = (deco as unknown as { type?: { attrs?: Record<string, unknown> } }).type
      const decoAttrs = decoType?.attrs
      if (decoAttrs && typeof decoAttrs.src === 'string') src = decoAttrs.src
    }
    this.img.src = src
    // null 不能直接赋给 DOM 属性：DOMString 会把 null 串成 "null"，
    // 表现为图片旁出现 "null" 提示气泡
    this.img.alt = attrs.alt ?? ''
    this.img.title = attrs.title ?? ''
    this.img.style.width = attrs.width != null ? `${attrs.width}px` : ''
    this.img.style.zoom = attrs.zoom != null ? `${attrs.zoom}%` : ''

    this.dom.classList.remove(
      'pm-image--left',
      'pm-image--center',
      'pm-image--right',
      'pm-image--solo',
    )
    if (attrs.align) {
      this.dom.classList.add(`pm-image--${attrs.align}`)
    } else {
      // Typora 同款默认：独占段落（无文本兄弟节点）的单图自动居中
      const pos = this.getPos()
      const parent = pos != null ? this.view.state.doc.resolve(pos).parent : null
      const solo = parent?.type.name === 'paragraph' && parent.childCount === 1
      if (solo) this.dom.classList.add('pm-image--solo')
    }
  }

  /** 对齐 / 重置（重置清空全部缩放与对齐属性，回到原生尺寸） */
  private applyAction(action: 'left' | 'center' | 'right' | 'reset') {
    const pos = this.getPos()
    if (pos == null) return
    const attrs = { ...this.node.attrs } as ImageAttrsRecord
    if (action === 'reset') {
      attrs.width = null
      attrs.align = ''
      attrs.zoom = null
    } else {
      attrs.align = action
    }
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs))
  }

  /** 拖拽缩放：mousemove 只改 DOM 预览，mouseup 一次性提交（单步撤销） */
  private startDrag(e: MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    // 上一轮拖拽若没收到 mouseup（在窗口外释放）仍留有 document 监听：
    // 先清理，避免本轮出现重复的 mousemove/mouseup 与重复提交
    this.cleanupDrag?.()
    const pos = this.getPos()
    if (pos == null) return
    const startX = e.clientX
    const startW = this.img.getBoundingClientRect().width
    const node = this.node
    const maxW = Math.max(MIN_WIDTH, this.view.dom.clientWidth)

    const move = (ev: MouseEvent) => {
      const w = Math.min(clampWidth(startW + (ev.clientX - startX)), maxW)
      this.img.style.width = `${w}px`
      this.img.style.zoom = ''
    }
    const up = (ev: MouseEvent) => {
      cleanup()
      if (this.getPos() == null) return
      const w = Math.min(clampWidth(startW + (ev.clientX - startX)), maxW)
      this.view.dispatch(
        this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: w, zoom: null }),
      )
    }
    const cleanup = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      this.cleanupDrag = null
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    this.cleanupDrag = cleanup
  }

  /**
   * ProseMirror 在节点更新时调用
   *
   * 节点类型不符时返回 false 让 ProseMirror 重建视图；否则刷新节点引用，并按新
   * attrs 与本次装饰（image-resolver 在节点装饰上放了解析后的 src）同步 DOM。
   *
   * @param node - 更新后的节点
   * @param decorations - 本次生效的装饰集（用于读取解析后的图片 src）
   * @returns true 表示更新已由本视图自行处理（无需重建）；false 表示需要重建视图
   */
  update(node: ProseNode, decorations: readonly Decoration[]): boolean {
    if (node.type.name !== 'image') return false
    this.node = node
    this.apply(node, decorations)
    return true
  }

  /** 节点被选中：给容器加上选中样式，从而显示对齐工具栏与缩放手柄 */
  selectNode() {
    this.dom.classList.add('pm-image--selected')
  }

  /** 节点取消选中：移除容器上的选中样式，隐藏对齐工具栏与缩放手柄 */
  deselectNode() {
    this.dom.classList.remove('pm-image--selected')
  }

  /**
   * 阻止特定 DOM 事件冒泡给 ProseMirror
   *
   * 手柄与浮层的事件自行处理；img 本身的点击/拖拽交给 ProseMirror（选中/移动节点）。
   *
   * @param event - 待判定的事件
   * @returns true 表示事件由本视图消费（发生在工具栏或手柄内），不再交给 ProseMirror
   */
  stopEvent(event: Event): boolean {
    const target = event.target as Node
    return this.toolbar.contains(target) || this.handle.contains(target)
  }

  /**
   * 告诉 ProseMirror 哪些 DOM 变更应被忽略，避免内部渲染被误判为用户编辑
   *
   * 纯 atom 展示视图，内部变化全部来自自己的 DOM 操作，故一律忽略。
   *
   * @returns true 表示忽略该变更（不当作编辑处理）
   */
  ignoreMutation(): boolean {
    return true
  }

  /** 视图销毁：清理未结束的拖拽（移除 document 上的 mousemove/mouseup 监听） */
  destroy() {
    this.cleanupDrag?.()
  }
}

// ProseMirror 以 (node, view, getPos, decorations, innerDecorations) 调用 NodeView
// 构造器，第 4 参是构造期就作用于本节点的外部装饰——必须原样透传给 ImageView，
// 否则首帧拿不到 image-resolver 解析的 file:// src（图片要等首次 update 才显示）
const imageView = $view(
  imageSchemaExt.node,
  () => (node, view, getPos, decorations) =>
    new ImageView(node, view, getPos, decorations),
)

/** 编辑器装配入口（editor-core 中 use；必须晚于 commonmark） */
export const imageAttrsPlugins = [imgAttrsRemark, imageSchemaExt, imageView].flat()
