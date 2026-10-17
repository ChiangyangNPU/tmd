import { describe, it, expect } from 'vitest'
import { convertHtmlBlocks, sanitizeRawHtml } from '../raw-html'
import { renderMarkdown } from '../export-doc'

type MdNode = {
  type: string
  value?: string | null
  children?: MdNode[]
  position?: unknown
}

describe('sanitizeRawHtml 白名单', () => {
  it('保留常见结构，剔除脚本 / 事件 / javascript: / class / id / style', () => {
    const out = sanitizeRawHtml(
      '<script>alert(1)</script><div onclick="x()" class="c" id="i" style="color:red">ok</div>' +
        '<a href="javascript:alert(1)" title="t">link</a>' +
        '<img src="data:image/png;base64,AAAA" onerror="x()" class="c">',
    )
    expect(out).toContain('<div>ok</div>')
    expect(out).toContain('<a title="t">link</a>')
    expect(out).toContain('<img src="data:image/png;base64,AAAA"')
    expect(out).not.toMatch(/<script|onclick|onerror|javascript:|class=|id=|style=/)
  })

  it('details / summary / table 等文档结构保留，iframe/svg 剔除', () => {
    const out = sanitizeRawHtml(
      '<details open><summary>More</summary><p>Body</p></details>' +
        '<table><tr><td colspan="2">x</td></tr></table>' +
        '<iframe src="https://x"></iframe><svg><script>alert(1)</script></svg>',
    )
    expect(out).toContain('<details open><summary>More</summary><p>Body</p></details>')
    expect(out).toContain('<td colspan="2">x</td>')
    expect(out).not.toMatch(/iframe|<svg/i)
  })
})

describe('convertHtmlBlocks', () => {
  it('根 / 引用里的 html 节点转 html_block，段落内行内 html 保持原样', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        { type: 'html', value: '<div>x</div>' },
        {
          type: 'paragraph',
          children: [
            { type: 'html', value: '<kbd>' },
            { type: 'text', value: 'Ctrl' },
            { type: 'html', value: '</kbd>' },
          ],
        },
        { type: 'blockquote', children: [{ type: 'html', value: '<div>q</div>' }] },
        // Milkdown remarkHtmlTransformer 的形态：块级 html 被包进仅含该 html 的段落
        { type: 'paragraph', children: [{ type: 'html', value: '<details>wrapped</details>' }] },
      ],
    }
    convertHtmlBlocks(tree)
    expect(tree.children![0]).toEqual({ type: 'html_block', value: '<div>x</div>' })
    expect(tree.children![1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'html', value: '<kbd>' },
        { type: 'text', value: 'Ctrl' },
        { type: 'html', value: '</kbd>' },
      ],
    })
    expect((tree.children![2] as MdNode).children![0]).toEqual({
      type: 'html_block',
      value: '<div>q</div>',
    })
    expect(tree.children![3]).toEqual({
      type: 'html_block',
      value: '<details>wrapped</details>',
    })
  })

  it('替换节点保留原 position（frontmatter extractRaw 依赖兄弟 position 切片）', () => {
    const pos = {
      start: { line: 2, column: 1, offset: 20 },
      end: { line: 2, column: 12, offset: 31 },
    }
    const tree: MdNode = {
      type: 'root',
      children: [{ type: 'html', value: '<div>x</div>', position: pos }],
    }
    convertHtmlBlocks(tree)
    expect((tree.children![0] as MdNode).position).toBe(pos)
  })
})

describe('导出侧原生 HTML', () => {
  it('块级 HTML 渲染并清洗，行内标签对按文本转义避免破坏嵌套', () => {
    const html = renderMarkdown(
      '<details><summary>More</summary><p>Body</p></details>\n\n' +
        '<script>alert(1)</script>\n\n' +
        'inline <kbd>Ctrl</kbd> text',
    )
    expect(html).toContain('<details><summary>More</summary><p>Body</p></details>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;kbd&gt;Ctrl&lt;/kbd&gt;')
  })
})
