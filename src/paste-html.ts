/**
 * HTML 粘贴转换：从网页/Word 复制的富文本粘贴时自动转为 Markdown 结构。
 *
 * - 剪贴板 text/html → DOMParser 解析（inert 文档，不执行脚本）→ 白名单清洗
 *   → prosemirror-model DOMParser.parseSlice 按编辑器 schema 转换（标题/列表/
 *   引用/加粗/斜体/删除线/行内代码/代码块/链接/图片/表格的 parseDOM 规则
 *   全部来自 Milkdown 预设，转换器零自研）
 * - 清洗两层：REMOVE（script/style/iframe 等连子树移除）、UNWRAP（span/div/
 *   font 等纯排版壳剥壳保文本）；属性仅保留 a[href]、img[src/alt]
 * - 协议白名单：链接仅放行 http/https/mailto 与相对路径，图片额外放行
 *   data:image（与粘贴图片内联策略一致），javascript:/data:text 等一律拦截
 * - 降级链：图片文件（paste-image 插件优先）→ HTML 转换 → 解析失败或空内容
 *   返回 false 交给 ProseMirror 默认纯文本粘贴
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { DOMParser as PmDOMParser } from '@milkdown/kit/prose/model'
import type { Schema, Slice } from '@milkdown/kit/prose/model'
import { parseZoom } from './image-attrs'

/** 连同子树一起移除：危险或对 Markdown 无意义 */
const REMOVE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'noscript',
  'template',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'map',
  'area',
  'applet',
  'frame',
  'frameset',
  'head',
  'title',
  'dialog',
])

/** Markdown 无法表达：剥壳保留内部文本（u/上下标与「无下划线」数据格式原则一致） */
const UNWRAP_TAGS = new Set([
  'span',
  'div',
  'font',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'center',
  'label',
  'u',
  'ins',
  'sub',
  'sup',
  'small',
  'big',
  'abbr',
  'cite',
  'q',
  'bdi',
  'bdo',
  'details',
  'summary',
  'picture',
])

/** 属性白名单：其余属性（style/class/id/onclick…）一律剥除 */
const KEEP_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  // img 保留缩放/对齐属性（width/align/style zoom），粘贴带尺寸的图片可保留
  img: new Set(['src', 'alt', 'title', 'width', 'align']),
}

/** 链接地址白名单：http/https/mailto 或无协议的相对路径 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  if (/^(https?:|mailto:)/i.test(trimmed)) return true
  // 含协议但不在白名单（javascript:/vbscript:/data:…）→ 拦截
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
}

/** 图片地址白名单：http/https、data:image（内联与粘贴图片策略一致）或相对路径 */
export function isSafeImageSrc(src: string): boolean {
  const trimmed = src.trim()
  if (!trimmed) return false
  if (/^https?:/i.test(trimmed)) return true
  if (/^data:image\//i.test(trimmed)) return true
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
}

/** 递归清洗一个元素（后序：先处理子树，再决定自身去留） */
function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase()

  // 命名空间垃圾（Word 的 o:p / st1:city 等）按剥壳处理
  if (REMOVE_TAGS.has(tag)) {
    el.remove()
    return
  }

  const allowed = KEEP_ATTRS[tag]
  for (const attr of [...el.attributes]) {
    if (!allowed?.has(attr.name.toLowerCase())) el.removeAttribute(attr.name)
  }
  if (tag === 'a' && !isSafeHref(el.getAttribute('href') ?? '')) {
    el.removeAttribute('href') // 不安全链接降级为纯文本
  }
  if (tag === 'img' && !isSafeImageSrc(el.getAttribute('src') ?? '')) {
    el.remove()
    return
  }
  // img 的 style 提纯：只保留 zoom 声明（Typora 缩放比），其余样式一律丢弃
  if (tag === 'img' && el.hasAttribute('style')) {
    const zoom = parseZoom(el.getAttribute('style') ?? '')
    if (zoom != null) el.setAttribute('style', `zoom:${zoom}%`)
    else el.removeAttribute('style')
  }

  for (const child of [...el.children]) sanitizeElement(child)

  if (UNWRAP_TAGS.has(tag) || tag.includes(':')) {
    el.replaceWith(...el.childNodes)
  }
}

/** HTML 字符串 → 清洗后的 DOM body；无有效内容返回 null */
function sanitizeHtmlBody(html: string): HTMLElement | null {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const body = dom.body
  if (!body) return null
  for (const child of [...body.children]) sanitizeElement(child)
  // 纯空白且无图：没有可转换的内容
  if (!body.textContent?.trim() && !body.querySelector('img')) return null
  return body
}

/** HTML → ProseMirror slice（按编辑器 schema 的 parseDOM 规则转换）；失败返回 null */
function htmlToSlice(html: string, schema: Schema): Slice | null {
  const body = sanitizeHtmlBody(html)
  if (!body) return null
  try {
    const slice = PmDOMParser.fromSchema(schema).parseSlice(body)
    return slice.content.childCount ? slice : null
  } catch (err) {
    console.warn('[tmd] HTML 粘贴转换失败，降级为纯文本粘贴', err)
    return null
  }
}

/** HTML 粘贴插件：注册在 pasteImage 之后——剪贴板含图片文件时让位给图片策略 */
export const pasteHtml = $prose(
  () =>
    new Plugin({
      props: {
        handlePaste: (view, event) => {
          const html = event.clipboardData?.getData('text/html')
          if (!html) return false
          if (event.clipboardData?.files.length) return false // 图片粘贴优先
          const slice = htmlToSlice(html, view.state.schema)
          if (!slice) return false
          event.preventDefault()
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
          return true
        },
      },
    }),
)
