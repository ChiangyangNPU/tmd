/**
 * EPUB 3 打包（纯函数，浏览器/Node 均可运行）。
 *
 * 离屏导出页完成 Markdown 渲染（Mermaid 已转内联 SVG、KaTeX 已转 HTML）后，
 * 把渲染结果序列化为 XHTML，再由本模块打成符合 EPUB 3 的最小包：
 * mimetype（首个、不压缩）→ META-INF/container.xml → OEBPS/{content.opf,
 * nav.xhtml, content.xhtml, style.css}。
 *
 * 已知边界：图片沿用导出页的 data URI（EPUB 阅读器兼容性参差）；Mermaid 以
 * 内联 SVG 保留（不栅格化）；KaTeX 样式与字体由调用方经 assets.katexCss 传入
 * （离线 HTML 资源里已把 woff2 转 data URI）。
 *
 * @author chiangyang
 */
import { strToU8, zipSync } from 'fflate'

export interface EpubHeading {
  level: number
  id: string
  text: string
}

/** 导出内嵌图片（Mermaid 已栅格化为 PNG；文件名形如 fig-1.png） */
export interface EpubImage {
  name: string
  bytes: Uint8Array
}

export interface EpubInput {
  title: string
  lang: string
  /** `<body>` 内部的 XHTML 片段（XMLSerializer 序列化，保证 XML 良构） */
  bodyHtml: string
  /** 导出样式（主题变量 + EXPORT_CSS + KaTeX CSS） */
  css: string
  headings: EpubHeading[]
  /** 正文引用的图片（src 已改写为 images/<name> 相对路径） */
  images?: EpubImage[]
}

/** XML 文本转义（标题/目录文本/属性） */
function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  )
}

/**
 * 把渲染产物修成合法 XHTML（epubcheck RSC-005 / OPF-014 的三项修复）：
 *
 * 1. Mermaid 的节点/边标签是 `<span class="…Label"><p>文本</p></span>`——
 *    XHTML 中行内元素不能包裹块级 p（编辑器页按 HTML 解析无所谓，ePub 按
 *    XML 校验）。SVG 内把 p 换成 span（同为行内，视觉差异仅在 p 的默认边距）。
 * 2. KaTeX 的 MathML 输出在元素之间夹有空白文本节点，MathML 内容模型
 *    不接受；元素间空白对 MathML 渲染无意义，直接剥掉。
 * 3. 由此产出的内容含 <svg> / <math> 时，OPF 清单必须声明对应 properties
 *    （buildEpubBytes 内检测）。
 */
export function sanitizeEpubXhtml(bodyHtml: string): string {
  return bodyHtml
    .replace(/<svg[\s\S]*?<\/svg>/g, (svg) => svg.replace(/<(\/?)p>/g, '<$1span>'))
    .replace(/<math[\s\S]*?<\/math>/g, (math) => math.replace(/>\s+</g, '><'))
}

/** 内容是否包含需要 OPF properties 声明的特性 */
export function epubManifestProperties(bodyHtml: string): string {
  const props: string[] = []
  if (/<math[\s>/]/.test(bodyHtml)) props.push('mathml')
  if (/<svg[\s>/]/.test(bodyHtml)) props.push('svg')
  return props.join(' ')
}

/** 生成导航目录（EPUB 3 nav；标题层级拍平为列表，兼容性最好） */
function buildNav(headings: EpubHeading[], title: string, lang: string): string {
  const items = headings
    .map(
      (h) =>
        `      <li><a href="content.xhtml#${encodeURIComponent(h.id)}">${escapeXml(h.text)}</a></li>`,
    )
    .join('\n')
  const list = items || `      <li><a href="content.xhtml">${escapeXml(title)}</a></li>`
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(
    lang,
  )}" xml:lang="${escapeXml(lang)}">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(title)}</h1>
    <ol>
${list}
    </ol>
  </nav>
</body>
</html>`
}

/** 生成 EPUB 3 字节（ZIP） */
export function buildEpubBytes(input: EpubInput): Uint8Array {
  const title = input.title || 'TMD'
  const lang = input.lang || 'und'
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `tmd-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  const manifest = epubManifestProperties(input.bodyHtml)
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${escapeXml(uuid)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"${manifest ? ` properties="${manifest}"` : ''}/>
    <item id="style" href="style.css" media-type="text/css"/>
${(input.images ?? [])
  .map(
    (img, i) =>
      `    <item id="img-${i + 1}" href="images/${escapeXml(img.name)}" media-type="image/png"/>`,
  )
  .join('\n')}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`
  const nav = buildNav(input.headings, title, lang)
  const content = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(
    lang,
  )}" xml:lang="${escapeXml(lang)}">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${sanitizeEpubXhtml(input.bodyHtml)}
</body>
</html>`
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // EPUB 规范要求 mimetype 是第一个条目且不压缩
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/content.xhtml': strToU8(content),
    'OEBPS/style.css': strToU8(input.css),
  }
  for (const img of input.images ?? []) {
    files[`OEBPS/images/${img.name}`] = img.bytes
  }
  return zipSync(files)
}
