import { describe, it, expect } from 'vitest'
import { buildThemeVarsBlock, buildExportHtml, renderMarkdown, stripFrontMatter } from '../export'

const LIGHT_VARS = {
  '--bg': '#ffffff',
  '--fg': '#24292f',
  '--muted': '#6a737d',
  '--border': '#e2e6ea',
  '--accent': '#4a7cd4',
  '--code-bg': '#f3f4f6',
  '--pre-bg': '#f6f8fa',
  '--quote-bg': 'transparent',
}

const DARK_VARS = {
  ...LIGHT_VARS,
  '--bg': '#1e2127',
  '--fg': '#d7dae0',
}

describe('buildThemeVarsBlock', () => {
  it('按固定顺序输出全部非空变量', () => {
    const block = buildThemeVarsBlock(LIGHT_VARS)
    const names = block
      .split('\n')
      .slice(1, -1)
      .map((line) => line.trim().split(':')[0])
    expect(names).toEqual([
      '--bg',
      '--fg',
      '--muted',
      '--border',
      '--accent',
      '--code-bg',
      '--pre-bg',
      '--quote-bg',
    ])
  })

  it('缺失的变量跳过而非输出空值', () => {
    expect(buildThemeVarsBlock({ '--bg': '#fff' })).toBe(':root {\n  --bg: #fff;\n}')
    expect(buildThemeVarsBlock({})).toBe(':root {\n\n}')
  })
})

describe('buildExportHtml', () => {
  const md = '# 标题\n\n正文'
  const base = (isDark: boolean, vars = LIGHT_VARS) => buildExportHtml(md, '笔记.md', vars, isDark)

  it('标题去掉 .md 后缀，正文渲染 markdown', () => {
    const html = base(false)
    expect(html).toContain('<title>笔记</title>')
    expect(html).toContain('<h1 id="标题">标题</h1>')
  })

  it('主题变量快照注入 :root，导出 CSS 以 var() 消费并带浅色兜底', () => {
    const html = base(false)
    expect(html).toContain(':root {\n  --bg: #ffffff;')
    expect(html).toContain('color: var(--fg, #24292f)')
    expect(html).not.toMatch(/color: #24292f;/) // 不再写死颜色
  })

  it('深色变量覆盖同名变量（快照在先，模板 var() 生效）', () => {
    const html = base(false, DARK_VARS)
    expect(html).toContain('--bg: #1e2127;')
  })

  it('mermaid 主题随深浅模式切换', () => {
    expect(base(false)).toContain("theme: 'default'")
    expect(base(true, DARK_VARS)).toContain("theme: 'dark'")
  })

  it('mermaid/katex 走 CDN 且保持 strict 安全级别', () => {
    const html = base(false)
    expect(html).toContain('mermaid@11/dist/mermaid.min.js')
    expect(html).toContain("securityLevel: 'strict'")
    expect(html).toContain('katex@0.16.11/dist/katex.min.js')
  })
})

describe('stripFrontMatter', () => {
  it('剥离文档开头的 YAML front matter，正文保留', () => {
    expect(stripFrontMatter('---\ntitle: 标题\n---\n\n正文内容')).toBe('\n正文内容')
  })

  it('正文中间的 --- 分隔线不动', () => {
    const md = '前文\n\n---\n\n后文'
    expect(stripFrontMatter(md)).toBe(md)
  })

  it('无 front matter 时原样返回', () => {
    expect(stripFrontMatter('# 标题\n\n正文')).toBe('# 标题\n\n正文')
  })

  it('仅 front matter 无正文时剥为空串', () => {
    expect(stripFrontMatter('---\ntitle: a\n---\n')).toBe('')
  })

  it('文档开头的水平线 + 段落不会被当作 front matter 吞掉', () => {
    const md = '---\n这是一段正文\n---\n\n后续内容'
    expect(stripFrontMatter(md)).toBe(md)
  })
})

describe('renderMarkdown 扩展语法', () => {
  it('==高亮== 渲染为 <mark>', () => {
    expect(renderMarkdown('这是 ==高亮== 文本')).toContain('这是 <mark>高亮</mark> 文本')
  })

  it('^上标^ 与 ~下标~ 渲染，~~删除线~~ 与单波浪互不干扰', () => {
    const html = renderMarkdown('x^2^、H~2~O、~~删除~~ 与 ~下标~')
    expect(html).toContain('x<sup>2</sup>')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('<s>删除</s>')
    expect(html).toContain('<sub>下标</sub>')
  })

  it('脚注渲染引用与文末定义区（锚点互链）', () => {
    const html = renderMarkdown('正文[^1]\n\n[^1]: 脚注内容')
    expect(html).toContain('class="footnote-ref"')
    expect(html).toContain('href="#fn1"')
    expect(html).toContain('class="footnotes"')
    expect(html).toContain('脚注内容')
  })

  it('front matter 不出现在导出 HTML 中', () => {
    const html = renderMarkdown('---\ntitle: 标题\n---\n\n正文')
    expect(html).not.toContain('title')
    expect(html).toContain('<p>正文</p>')
  })

  it('行内代码中的分隔符不被解析', () => {
    expect(renderMarkdown('`a^b^ c==d==`')).toContain('<code>a^b^ c==d==</code>')
  })

  it('空标题也会生成可用锚点，多个空标题互不冲突', () => {
    const html = renderMarkdown('# \n\n# ')
    expect(html).toContain('id="heading"')
    expect(html).toContain('id="heading-1"')
  })
})

describe('renderMarkdown 公式保护', () => {
  it('行内公式原文完整保留（^ _ 不被上/下标插件改写）', () => {
    const html = renderMarkdown('行内 $E = mc^2$ 与 $x_{1}^{2}$ 结束')
    expect(html).toContain('$E = mc^2$')
    expect(html).toContain('$x_{1}^{2}$')
    expect(html).not.toContain('<sup>')
    expect(html).not.toContain('<sub>')
  })

  it('LaTeX 转义命令不被 markdown-it 转义规则吞掉（\\, \\{ \\}）', () => {
    const html = renderMarkdown('$a \\, b \\{c\\}$')
    expect(html).toContain('\\,')
    expect(html).toContain('\\{c\\}')
  })

  it('独占公式跨行保留原文（供 KaTeX display 模式渲染）', () => {
    const html = renderMarkdown('$$\n\\int_{0}^{1} \\frac{x^{2}}{1+x^{2}} \\, dx\n$$')
    expect(html).toContain('\\int_{0}^{1}')
    expect(html).toContain('\\frac{x^{2}}{1+x^{2}}')
    expect(html).toContain('\\, dx')
    expect(html).toContain('$$')
  })

  it('货币写法不误判为公式（开闭 $ 之间有空白边界）', () => {
    const html = renderMarkdown('价格 $5 与 $6 的差异')
    expect(html).toContain('$5')
    expect(html).toContain('$6')
  })

  it('行内代码与代码块中的 $ 不受影响', () => {
    expect(renderMarkdown('`$a^2$`')).toContain('<code>$a^2$</code>')
    expect(renderMarkdown('```\n$$x$$\n```')).toContain('$$x$$')
  })

  it('公式内的 \\$ 是字面美元符，不作为闭合分隔符提前截断', () => {
    // 修复前会在 \$ 处闭合，公式只剩 "$a \$"，丢失后半段
    expect(renderMarkdown('$a \\$ b$')).toContain('$a \\$ b$')
  })

  it('其他扩展语法仍在公式之外正常工作', () => {
    const html = renderMarkdown('==高亮== 与 $a^2$ 与 H~2~O')
    expect(html).toContain('<mark>高亮</mark>')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('$a^2$')
  })
})
