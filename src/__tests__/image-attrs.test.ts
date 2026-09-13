import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import {
  serializeImgHtml,
  parseImgHtml,
  parseZoom,
  clampWidth,
  imgInlineStyle,
  transformImgHtmlNodes,
} from '../image-attrs'
import { convertImgTokens, renderMarkdown } from '../export'

/** 用真实 remark-parse 产出 mdast（与编辑器解析路径同款） */
function unifiedParse(md: string): unknown {
  return unified().use(remarkParse).parse(md)
}

const FULL = {
  src: 'assets/a.png',
  alt: '图 A',
  title: null,
  width: 300,
  align: 'center' as const,
  zoom: null,
}

describe('serializeImgHtml', () => {
  it('无缩放/对齐属性返回 null（保持原生语法零变化）', () => {
    expect(
      serializeImgHtml({ src: 'a.png', alt: '', title: null, width: null, align: '', zoom: null }),
    ).toBeNull()
  })

  it('有属性时输出白名单属性标签', () => {
    expect(serializeImgHtml(FULL)).toBe(
      '<img src="assets/a.png" alt="图 A" width="300" align="center">',
    )
  })

  it('zoom 走 style 声明（Typora 同款）', () => {
    expect(serializeImgHtml({ ...FULL, width: null, align: '', zoom: 50 })).toBe(
      '<img src="assets/a.png" alt="图 A" style="zoom:50%">',
    )
  })

  it('属性值转义 HTML 特殊字符', () => {
    const html = serializeImgHtml({
      src: 'a&b<c>.png',
      alt: '"x"',
      title: null,
      width: 100,
      align: '',
      zoom: null,
    })
    expect(html).toBe('<img src="a&amp;b&lt;c&gt;.png" alt="&quot;x&quot;" width="100">')
  })

  it('src 为空返回 null', () => {
    expect(
      serializeImgHtml({ src: '', alt: 'a', title: null, width: 100, align: '', zoom: null }),
    ).toBeNull()
  })
})

describe('parseImgHtml', () => {
  it('往返：serialize 输出可解析回原属性', () => {
    const html = serializeImgHtml(FULL)
    // title 缺失会被 serialize 略去，parse 归一为 ''（与 image 节点 attrs 默认值一致）
    expect(parseImgHtml(html as string)).toEqual({ ...FULL, title: '' })
  })

  it('解析 Typora 的 zoom style', () => {
    expect(parseImgHtml('<img src="a.png" style="zoom: 50%">')).toEqual({
      src: 'a.png',
      alt: '',
      title: '',
      width: null,
      align: '',
      zoom: 50,
    })
  })

  it('单引号与无引号属性值、自闭合斜杠', () => {
    expect(parseImgHtml("<img src='a.png' width=200 align='right' />")?.width).toBe(200)
    expect(parseImgHtml("<img src='a.png' width=200 align='right' />")?.align).toBe('right')
  })

  it('宽度百分比写法忽略，非整数忽略', () => {
    expect(parseImgHtml('<img src="a.png" width="50%">')).toBeNull()
    expect(parseImgHtml('<img src="a.png" width="abc">')).toBeNull()
  })

  it('非 img 标签与不规则标签拒识', () => {
    expect(parseImgHtml('<div src="a.png" width="100"></div>')).toBeNull()
    expect(parseImgHtml('not an img')).toBeNull()
    expect(parseImgHtml('<img src="a.png" width="100')).toBeNull() // 未闭合
  })

  it('不安全 src 拒识（协议白名单）', () => {
    expect(parseImgHtml('<img src="javascript:alert(1)" width="100">')).toBeNull()
  })

  it('无缩放对齐属性返回 null（不做转换）', () => {
    expect(parseImgHtml('<img src="a.png" alt="普通图">')).toBeNull()
  })

  it('实体转义反转义', () => {
    expect(parseImgHtml('<img src="a&amp;b.png" width="100">')?.src).toBe('a&b.png')
  })
})

describe('parseZoom / clampWidth / imgInlineStyle', () => {
  it('zoom 兼容百分比与无单位写法', () => {
    expect(parseZoom('zoom:50%')).toBe(50)
    expect(parseZoom('zoom:0.5')).toBe(50)
    expect(parseZoom('color:red; zoom: 120 %; width:1px')).toBe(120)
    expect(parseZoom('color:red')).toBeNull()
    expect(parseZoom('zoom:2000%')).toBeNull() // 超出钳制范围
  })

  it('clampWidth 钳制并取整', () => {
    expect(clampWidth(10)).toBe(32)
    expect(clampWidth(99999999)).toBe(99999)
    expect(clampWidth(299.6)).toBe(300)
  })

  it('imgInlineStyle 组合', () => {
    expect(imgInlineStyle(300, null)).toBe('width:300px')
    expect(imgInlineStyle(null, 50)).toBe('zoom:50%')
    expect(imgInlineStyle(300, 50)).toBe('width:300px;zoom:50%')
    expect(imgInlineStyle(null, null)).toBe('')
  })
})

describe('transformImgHtmlNodes', () => {
  const run = (md: string) => {
    const tree = unifiedParse(md)
    transformImgHtmlNodes(tree as never)
    return tree
  }

  it('行内位置：<img> 替换为 image 节点且携带 data', () => {
    const tree = run('前文 <img src="a.png" width="300" align="center"> 后文')
    const children = (tree as unknown as { children: { type: string; children?: unknown[] }[] })
      .children
    expect(children[0].type).toBe('paragraph')
    const inline = children[0].children as { type: string; url?: string; data?: unknown }[]
    expect(inline.map((n) => n.type)).toEqual(['text', 'image', 'text'])
    expect(inline[1].url).toBe('a.png')
    expect(inline[1].data).toEqual({ width: 300, align: 'center' })
  })

  it('独占一行：包一层 paragraph（root 不收 inline）', () => {
    const tree = run('<img src="b.png" width="200" alt="独占">')
    const children = (tree as unknown as { children: { type: string; children?: unknown[] }[] })
      .children
    expect(children.length).toBe(1)
    expect(children[0].type).toBe('paragraph')
    const img = (children[0].children as { type: string; alt?: string }[])[0]
    expect(img.type).toBe('image')
    expect(img.alt).toBe('独占')
  })

  it('非 img 的 html 节点与 TOC 注释不动', () => {
    const tree = run('<script>alert(1)</script>\n\n<!-- TOC -->\n')
    const children = (tree as unknown as { children: { type: string }[] }).children
    expect(children[0].type).toBe('html')
    expect(children[1].type).toBe('html')
  })

  it('不安全 src 保持 html 节点', () => {
    const tree = run('<img src="javascript:alert(1)" width="100">')
    const children = (tree as unknown as { children: { type: string }[] }).children
    expect(children[0].type).toBe('html')
  })
})

describe('convertImgTokens（导出管线）', () => {
  const md = new MarkdownIt({ html: false, linkify: true })

  const inlineChildren = (src: string) => {
    const tokens = md.parse(src, {})
    convertImgTokens(tokens)
    return tokens.filter((t) => t.type === 'inline').flatMap((t) => t.children ?? [])
  }

  it('text 中的 img 标签转换为 image token 并带属性', () => {
    const out = inlineChildren('<img src="a.png" width="300" align="center">')
    expect(out.map((t) => t.type)).toEqual(['image'])
    expect(out[0].attrGet('src')).toBe('a.png')
    expect(out[0].attrGet('width')).toBe('300')
    expect(out[0].attrGet('align')).toBe('center')
  })

  it('前后文本拆分保留', () => {
    const out = inlineChildren('前 <img src="a.png" width="32"> 后')
    expect(out.map((t) => t.type)).toEqual(['text', 'image', 'text'])
    expect(out[0].content).toBe('前 ')
    expect(out[2].content).toBe(' 后')
  })

  it('渲染为真实 <img> 标签而非转义文本', () => {
    // 走导出管线真实路径（内部 mdIt 实例含自定义 image 渲染规则）
    const html = renderMarkdown('<img src="a.png" width="120">')
    expect(html).toContain('<img src="a.png" alt="" width="120">')
    expect(html).not.toContain('&lt;img')
  })

  it('普通文本与不安全 src 不受影响', () => {
    const out = inlineChildren('正文 <img src="javascript:x" width="100"> 收尾')
    expect(out.map((t) => t.type)).toEqual(['text'])
    expect(out[0].content).toContain('<img src="javascript:x"')
  })
})
