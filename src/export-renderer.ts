/**
 * 离屏导出页引导（export-renderer.html 的入口）。
 *
 * 这里是导出编排的唯一位置（策略模式：按 task.kind 分派 word / longimage），
 * 两条路径共用同一条渲染管线：
 *   注入文档 → 图片本地化 → 公式渲染（KaTeX）→ 字体就绪 → 图表渲染（Mermaid）
 *   → 分派处理器 → 回传字节
 *
 * 页面结构与独立 HTML 导出一致（正文直接作为 body 内容、样式表注入 <head>），
 * 保证三种载体的版式来自同一份 CSS 与同一次 Markdown 渲染。
 *
 * @author chiangyang
 */
import 'katex/dist/katex.min.css'
import renderMathInElement from 'katex/dist/contrib/auto-render.mjs'
import { resolveExportImageRef } from './export-doc'
import type { ExportTask } from './export-bridge'
import type { ExporterBridge } from './export-bridge'
import { buildDocxBytes } from './export-word'
import { composeLongPng, planSegments, zoomForDpr } from './export-image'

/** 导出正文页面宽度（EXPORT_CSS 的 max-width 860 + 左右 padding 32×2）= 无需横向留白 */
const EXPORT_PAGE_WIDTH_CSS = 924
/** KaTeX 自动渲染的分隔符（与独立 HTML 导出、编辑器内一致） */
const MATH_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '$', right: '$', display: false },
]

/** 等待两帧，确保布局与重绘落地 */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/**
 * 注入任务文档：语言/标题、变量与样式表、正文。
 * 复用窗口时先整体复位（清空内容、样式、zoom、滚动位置），避免上一任务的残留。
 */
function injectDocument(task: ExportTask): void {
  document.documentElement.lang = task.lang
  document.title = task.title
  document.body.style.zoom = ''
  document.body.scrollTop = 0
  document.documentElement.scrollTop = 0

  for (const id of ['export-vars', 'export-css']) {
    document.getElementById(id)?.remove()
  }
  const vars = document.createElement('style')
  vars.id = 'export-vars'
  vars.textContent = task.varsBlock
  const css = document.createElement('style')
  css.id = 'export-css'
  css.textContent = task.css
  document.head.append(vars, css)

  document.body.innerHTML = task.bodyHtml
}

/**
 * 图片本地化：文档里的相对路径图片在离屏页不可见（无 file: 读取权限），
 * 经主进程白名单原语读成 data URI 内联；data: 与远程图片保持原样。
 * 读取失败的图片保留原 src（渲染时呈现 alt 文本），不阻断整篇导出。
 */
async function localizeImages(bridge: ExporterBridge, baseDir: string | null): Promise<void> {
  const images = Array.from(document.body.querySelectorAll('img'))
  await Promise.all(
    images.map(async (img) => {
      const ref = resolveExportImageRef(img.getAttribute('src'), baseDir)
      if (ref.kind !== 'local') return
      const dataUri = await bridge.readImage(ref.fileUrl)
      if (dataUri) img.src = dataUri
    }),
  )
}

/** 等待所有图片解码完成（避免测量高度时图片尚未占位） */
async function waitImages(): Promise<void> {
  const images = Array.from(document.body.querySelectorAll('img'))
  await Promise.all(
    images.map((img) => (img.decode ? img.decode().catch(() => undefined) : undefined)),
  )
}

/** 公式渲染：扫描 $...$ / $$...$$（本地 KaTeX，离线可用） */
function renderMath(): void {
  renderMathInElement(document.body, { delimiters: MATH_DELIMITERS })
}

/** 图表渲染：```mermaid 占位块交给本地 mermaid（离线可用，主题随深浅模式）；
 *  mermaid 较重且仅在文档含图表时需要，动态加载避免并入两入口共享分包。
 *
 *  逐块渲染并各自兜错：单个图表语法错误只让该块降级为源码文本，
 *  不阻断整篇导出（mermaid.run 对语法错误会整体 reject）。 */
async function renderMermaid(isDark: boolean): Promise<void> {
  const nodes = Array.from(document.body.querySelectorAll<HTMLElement>('pre.mermaid'))
  if (nodes.length === 0) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
  })
  for (const node of nodes) {
    // 渲染失败时 mermaid 可能已就地改写节点内容，先留一份源码用于降级还原
    const source = node.textContent ?? ''
    try {
      await mermaid.run({ nodes: [node] })
    } catch (err) {
      console.warn('[tmd] Mermaid 渲染失败，该块降级为源码文本', err)
      node.classList.remove('mermaid')
      node.textContent = source
    }
  }
}

/**
 * 长图导出：按显示像素比归一清晰度后分段截图拼接。
 * @returns PNG 字节
 */
async function exportLongImage(bridge: ExporterBridge): Promise<Uint8Array> {
  // 清晰度归一：把 body 置于 zoom 坐标系（zoom × dpr ≥ 2），
  // 之后所有测量都在该坐标系内（物理像素 = CSS × pixelRatio）
  const dpr = window.devicePixelRatio || 1
  const zoom = zoomForDpr(dpr)
  document.body.style.zoom = zoom > 1 ? String(zoom) : ''
  await nextFrames()

  const widthCss = EXPORT_PAGE_WIDTH_CSS
  const heightCss = document.body.scrollHeight
  const planned = planSegments(widthCss, heightCss, zoom * dpr)
  if (!planned.ok) {
    throw new Error(`文档过长，无法导出为单张长图（${planned.physicalHeight}px）`)
  }

  // 滚动：html 未缩放，文档滚动坐标 = DIP，故偏移需乘 zoom 换算
  const scrollTo = async (offsetCss: number) => {
    document.documentElement.scrollTop = Math.round(offsetCss * zoom)
    await nextFrames()
  }
  const capture = (req: Parameters<ExporterBridge['capture']>[0]) => bridge.capture(req)
  const background = getComputedStyle(document.body).backgroundColor || '#ffffff'

  return composeLongPng(
    planned.plan,
    { widthCss, zoom, pixelRatio: zoom * dpr },
    capture,
    scrollTo,
    background,
  )
}

/** 处理一个导出任务并回传结果 */
async function handleTask(bridge: ExporterBridge, task: ExportTask): Promise<void> {
  try {
    injectDocument(task)
    await localizeImages(bridge, task.baseDir)
    // 图片须先完成解码，后续公式/图表渲染与高度测量才有正确的占位
    await waitImages()
    renderMath()
    // 公式换行与 mermaid 布局都依赖字体度量，等字体就绪后再测量/渲染
    await document.fonts.ready
    await renderMermaid(task.isDark)
    await nextFrames()

    const bytes =
      task.kind === 'word'
        ? await buildDocxBytes(bridge, document.body, task.lang, 1)
        : await exportLongImage(bridge)
    await bridge.taskDone({ ok: true, bytes })
  } catch (err) {
    await bridge.taskDone({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

const bridge = window.exporterAPI
if (bridge) {
  let busy = false
  bridge.onTask((task) => {
    // 主进程已串行下发；此处再兜一层，防止意外并发导致 DOM 互踩
    if (busy) {
      void bridge.taskDone({ ok: false, error: '已有导出任务进行中' })
      return
    }
    busy = true
    void handleTask(bridge, task).finally(() => {
      busy = false
    })
  })
}
