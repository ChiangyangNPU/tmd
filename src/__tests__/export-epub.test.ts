import { describe, it, expect } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { buildEpubBytes, epubManifestProperties, sanitizeEpubXhtml } from '../export-epub'

function makeEpub(overrides: Partial<Parameters<typeof buildEpubBytes>[0]> = {}) {
  return buildEpubBytes({
    title: 'Book & Title',
    lang: 'zh-CN',
    bodyHtml: '<h1 id="intro">Intro</h1><p>Hello</p>',
    css: 'body { color: #222; }',
    headings: [{ level: 1, id: 'intro', text: 'Intro' }],
    ...overrides,
  })
}

function entries(bytes: Uint8Array): Record<string, string> {
  const zipped = unzipSync(bytes)
  return Object.fromEntries(Object.entries(zipped).map(([name, data]) => [name, strFromU8(data)]))
}

describe('buildEpubBytes', () => {
  it('生成 EPUB 3 必要条目，mimetype 为首个且不压缩', () => {
    const bytes = makeEpub()
    const buffer = Buffer.from(bytes)
    // ZIP local file header：文件名从 offset 30 开始，压缩方法在 offset 8（0 = stored）
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(buffer.readUInt16LE(8)).toBe(0)
    expect(buffer.subarray(30, 38).toString('utf-8')).toBe('mimetype')

    const files = entries(bytes)
    expect(files['mimetype']).toBe('application/epub+zip')
    expect(files['META-INF/container.xml']).toContain('OEBPS/content.opf')
    expect(files['OEBPS/content.opf']).toContain('version="3.0"')
    expect(files['OEBPS/content.opf']).toContain('unique-identifier="bookid"')
    expect(files['OEBPS/content.opf']).toContain('Book &amp; Title')
    expect(files['OEBPS/content.opf']).toContain('<dc:language>zh-CN</dc:language>')
    expect(files['OEBPS/content.xhtml']).toContain('<p>Hello</p>')
    expect(files['OEBPS/style.css']).toContain('body { color: #222; }')
  })

  it('nav 包含标题锚点并做 URL/XML 转义', () => {
    const files = entries(
      makeEpub({
        title: 'T',
        headings: [{ level: 2, id: '中文 标题', text: '<Intro> & more' }],
      }),
    )
    expect(files['OEBPS/nav.xhtml']).toContain(
      'content.xhtml#%E4%B8%AD%E6%96%87%20%E6%A0%87%E9%A2%98',
    )
    expect(files['OEBPS/nav.xhtml']).toContain('&lt;Intro&gt; &amp; more')
    expect(files['OEBPS/nav.xhtml']).toContain('epub:type="toc"')
  })

  it('无标题时 nav 回落到正文链接', () => {
    const files = entries(makeEpub({ headings: [] }))
    expect(files['OEBPS/nav.xhtml']).toContain('<a href="content.xhtml">Book &amp; Title</a>')
  })

  it('KaTeX CSS 可并入样式表（字体 data URI 原样保留）', () => {
    const files = entries(
      makeEpub({ css: '@font-face{src:url(data:font/woff2;base64,AAAA)} body{}' }),
    )
    expect(files['OEBPS/style.css']).toContain('data:font/woff2;base64,AAAA')
  })

  it('XHTML 修复：SVG 内 p→span、MathML 剥元素间空白、OPF 声明 mathml/svg', () => {
    const body =
      '<svg><span class="edgeLabel"><p>是</p></span></svg>' +
      '<math><mrow> <mi>x</mi> <mo>+</mo> <mn>1</mn> </mrow></math>'
    const files = entries(makeEpub({ bodyHtml: body }))
    const content = files['OEBPS/content.xhtml']
    expect(content).toContain('<span class="edgeLabel"><span>是</span></span>')
    expect(content).not.toMatch(/<svg[\s\S]*?<p>/)
    expect(content).toContain('<mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow>')
    expect(files['OEBPS/content.opf']).toContain('properties="mathml svg"')
  })

  it('无 math/svg 内容时 OPF 不声明 properties', () => {
    const files = entries(makeEpub({ bodyHtml: '<p>纯文本</p>' }))
    expect(files['OEBPS/content.opf']).not.toMatch(/<item id="content"[^>]*properties=/)
  })

  it('sanitizeEpubXhtml 不触碰 SVG/Math 之外的 p（正文段落保持原样）', () => {
    const body = '<p>正文</p><svg><foreignObject><p>label</p></foreignObject></svg>'
    expect(sanitizeEpubXhtml(body)).toBe(
      '<p>正文</p><svg><foreignObject><span>label</span></foreignObject></svg>',
    )
  })

  it('epubManifestProperties 按内容检测', () => {
    expect(epubManifestProperties('<p>x</p>')).toBe('')
    expect(epubManifestProperties('<svg>...</svg>')).toBe('svg')
    expect(epubManifestProperties('<math>...</math>')).toBe('mathml')
    expect(epubManifestProperties('<math/><svg/>')).toBe('mathml svg')
  })
})
