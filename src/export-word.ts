/**
 * Word（.docx）导出：在离屏页内把已渲染的导出 DOM 转为原生可编辑 OOXML。
 *
 * 适配策略（转换器藏在单一函数之后，替换引擎只需改本文件）：
 * 1. 复杂视觉块（独占公式 .katex-display、Mermaid 图表 svg）统一用「真实合成器
 *    区域截帧」栅格为 PNG 再替换元素：
 *    - KaTeX 是大量精细 span，转成 Word 文本必然走形；
 *    - Mermaid SVG 不能交给转换器的 rasterizeInPlace（它把 SVG 画进 canvas 再
 *      toDataURL，该 SVG 内含 foreignObject 时会被判定污染而抛错），
 *      也不宜走 SVG foreignObject 自绘（沙箱里取不到网页字体）。
 *    区域截帧是唯一同时保字体、保矢量细节且不触发画布污染的路线。
 * 2. 图片：本地图片已在渲染管线内转为 data URI；此处只兜底远程图片（由离屏页
 *    按自身 CSP 直接 fetch，主进程不参与，符合「渲染层无文件系统权限」的边界）。
 *
 * @author chiangyang
 */
import { convertHtmlToDocxUint8Array } from 'dom-docx/browser'
import type { ImageResolver, ResolvedImage } from 'dom-docx/browser'
import type { ExporterBridge } from './export-bridge'

/**
 * Word 转换前设置的离屏视口：需容纳最高的那张图表/公式（区域截帧只能取可见部分），
 * 故取一个远高于常规屏幕的高度（隐藏窗口已开启 enableLargerThanScreen）。
 */
const WORD_VIEWPORT = { widthCss: 924, heightCss: 4000 }
/** 单张远程图片字节上限（与主进程本地图片上限一致） */
const MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024
/** 单次导出最多栅格化的视觉块数（超出部分保留原 DOM，避免耗时失控） */
const MAX_RASTERIZED_BLOCKS = 120
/** 栅格化时的额外边距（CSS px，避免边缘被裁切） */
const BLOCK_PADDING = 2

/**
 * 需栅格化的复杂视觉块选择器（按文档顺序处理）：
 * - .katex-display：独占公式（KaTeX span 结构）
 * - pre.mermaid：Mermaid 图表（取其外层 pre 而非内层 svg，避免图片被困在
 *   等宽 pre 块里；该 SVG 含 foreignObject，不能走画布栅格化）
 */
const RASTERIZE_SELECTOR = '.katex-display, pre.mermaid'

/** 支持的位图 MIME → dom-docx 的 ImageType */
const MIME_TO_IMAGE_TYPE: Record<string, ResolvedImage['type']> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

/**
 * 由 MIME（优先）或扩展名推断图片类型；Word 只支持 png/jpg/gif/bmp 位图。
 * @param mime - HTTP Content-Type（可能为空）
 * @param src - 图片地址（用于回退判扩展名）
 */
function imageTypeOf(mime: string, src: string): ResolvedImage['type'] | null {
  const normalized = mime.split(';')[0].trim().toLowerCase()
  if (MIME_TO_IMAGE_TYPE[normalized]) return MIME_TO_IMAGE_TYPE[normalized]
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src)?.[1]?.toLowerCase()
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  if (ext === 'gif') return 'gif'
  if (ext === 'bmp') return 'bmp'
  return null
}

/**
 * 远程图片解析器：离屏页直接 fetch（专用 CSP 放行 https/http），
 * 失败或不支持的格式返回 null（转换器回退为 alt 文本，不阻断整篇转换）。
 */
const remoteImageResolver: ImageResolver = async (src) => {
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const type = imageTypeOf(res.headers.get('content-type') ?? '', src)
    if (!type) return null
    const data = await res.arrayBuffer()
    if (data.byteLength > MAX_REMOTE_IMAGE_BYTES) return null
    return { data, type }
  } catch {
    return null
  }
}

/** 等待两帧，确保布局/重绘落地（滚动后测量与截帧前调用） */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** 元素是否完整落在当前视口内（区域截帧只能取到可见部分） */
function isFullyVisible(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  )
}

/**
 * 超出栅格化上限的视觉块降级为源码文本：
 * - Mermaid：去掉 mermaid 类，按普通代码块转换，保留图表源码
 * - KaTeX 独占公式：优先取 MathML 里 annotation 的 LaTeX 原文，取不到则退回纯文本
 */
function degradeUnrasterizedBlocks(blocks: HTMLElement[]): void {
  for (const el of blocks) {
    if (el.matches('pre.mermaid')) {
      el.classList.remove('mermaid')
      continue
    }
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    const fallback = document.createElement('pre')
    fallback.textContent = tex?.trim() || el.textContent?.trim() || ''
    el.replaceWith(fallback)
  }
}

/**
 * 把复杂视觉块（独占公式、Mermaid 图表）栅格化为位图（替换原元素）：
 * 逐条滚动到视口内 → 区域截帧 → 用 <img> 替换，尺寸取自测量矩形。
 * 任一步失败即保留原 DOM（降级为文本/矢量，不影响导出成功）。
 *
 * @param bridge - 离屏页桥接（区域截帧原语）
 * @param root - 导出根元素
 * @param zoom - CSS px → DIP 换算系数（与页面 zoom 一致）
 * @returns 实际栅格化的块数
 */
export async function rasterizeVisualBlocks(
  bridge: ExporterBridge,
  root: HTMLElement,
  zoom: number,
): Promise<number> {
  const all = Array.from(root.querySelectorAll<HTMLElement>(RASTERIZE_SELECTOR))
  const targets = all.slice(0, MAX_RASTERIZED_BLOCKS)
  degradeUnrasterizedBlocks(all.slice(MAX_RASTERIZED_BLOCKS))
  let done = 0
  for (const el of targets) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      await nextFrames()
      const rect = el.getBoundingClientRect()
      if (!isFullyVisible(rect)) continue
      const region = {
        x: Math.max(0, rect.left - BLOCK_PADDING),
        y: Math.max(0, rect.top - BLOCK_PADDING),
        width: rect.width + BLOCK_PADDING * 2,
        height: rect.height + BLOCK_PADDING * 2,
      }
      const shot = await bridge.capture({ region, zoom })
      if (!shot) continue
      const img = document.createElement('img')
      img.src = shot.dataUrl
      img.width = Math.round(region.width)
      img.height = Math.round(region.height)
      img.alt = el.textContent ?? ''
      // 图表在原版式中居中（EXPORT_CSS 的 .mermaid 为 flex 居中），替换后保持一致
      if (el.matches('pre.mermaid')) {
        img.style.display = 'block'
        img.style.margin = '0 auto'
      }
      el.replaceWith(img)
      done++
    } catch {
      // 单条失败保留原 DOM：该块退化为文本，不影响整篇导出
    }
  }
  return done
}

/**
 * 把导出根元素转换为 .docx 字节。
 *
 * @param bridge - 离屏页桥接
 * @param root - 导出根元素（正文 HTML 的容器）
 * @param lang - 文档语言（Word 拼写检查区域）
 * @param zoom - CSS px → DIP 换算系数
 */
export async function buildDocxBytes(
  bridge: ExporterBridge,
  root: HTMLElement,
  lang: string,
  zoom: number,
): Promise<Uint8Array> {
  // 先固定视口：区域截帧只能取到可见部分，故需足够高的视口容纳图表/公式
  await bridge.capture({ ...WORD_VIEWPORT, zoom })
  await rasterizeVisualBlocks(bridge, root, zoom)

  // 收集转换器的降级告警（图片/样式无法映射等），仅在调试时输出，不打扰用户
  const warnings: string[] = []
  const bytes = await convertHtmlToDocxUint8Array(root.innerHTML, {
    // 从 live DOM 读计算样式：导出版式在样式表与 CSS 变量里，无内联 style
    styleSource: 'computed',
    document,
    root,
    // 图表/公式已用区域截帧自行栅格化；关闭转换器的 canvas 栅格化
    // （它把含 foreignObject 的 SVG 画入 canvas 会触发画布污染而抛错）
    rasterizeInPlace: false,
    imageResolver: remoteImageResolver,
    onWarning: (message) => warnings.push(message),
    lang,
    // 中文文档惯例用 A4（转换器默认 US Letter）
    pageSize: 'a4',
  })
  if (warnings.length) console.warn('[tmd] Word 导出降级告警', warnings)
  return bytes
}
