import { describe, it, expect } from 'vitest'
import {
  assembleLatexDocument,
  containsCJK,
  escapeLatex,
  renderLatexDocument,
} from '../export-latex'

/** 取 \begin{document} 与 \end{document} 之间的正文（便于断言） */
function bodyOf(tex: string): string {
  return tex.split('\\begin{document}\n')[1]?.split('\\end{document}')[0] ?? ''
}

describe('escapeLatex', () => {
  it('特殊字符逐一逃逸', () => {
    expect(escapeLatex('#$%&_')).toBe('\\#\\$\\%\\&\\_')
    expect(escapeLatex('{}')).toBe('\\{\\}')
    expect(escapeLatex('~^')).toBe('\\textasciitilde{}\\textasciicircum{}')
    expect(escapeLatex('<>|')).toBe('\\textless{}\\textgreater{}\\textbar{}')
    expect(escapeLatex('\\section')).toBe('\\textbackslash{}section')
  })

  it('普通文本与中文原样保留', () => {
    expect(escapeLatex('Hello 世界 123')).toBe('Hello 世界 123')
  })

  it('逃逸不二次处理反斜杠产物', () => {
    const once = escapeLatex('a_b\\c')
    expect(once).toBe('a\\_b\\textbackslash{}c')
    // 产物里包含 \ 与 _，但已不再逃逸（否则会出现 \\_）
    expect(once).not.toContain('\\\\_')
  })

  it('输入含私用区字符时原样保留（不被当成占位符改写）', () => {
    const tricky = 'a\uE000BS\uE000b'
    expect(escapeLatex(tricky)).toBe(tricky)
  })
})

describe('containsCJK', () => {
  it('中文 / 假名 / 谚文为真，纯西文为假', () => {
    expect(containsCJK('中文')).toBe(true)
    expect(containsCJK('ひらがな')).toBe(true)
    expect(containsCJK('한글')).toBe(true)
    expect(containsCJK('hello world')).toBe(false)
  })
})

describe('renderLatexDocument', () => {
  it('preamble：标题注释 / magic comment / 文档类 / \begin{document}', () => {
    const tex = renderLatexDocument('# 标题\n\n正文', 'demo.md')
    expect(tex).toContain('% !TEX program = xelatex')
    expect(tex).toContain('% 文档标题：demo')
    expect(tex).toContain('\\documentclass[12pt]{ctexart}')
    expect(tex).toContain('\\begin{document}')
    expect(tex.trimEnd().endsWith('\\end{document}')).toBe(true)
  })

  it('纯西文文档用 article 文档类', () => {
    const tex = renderLatexDocument('# English\n\nbody', 'demo.md')
    expect(tex).toContain('\\documentclass[12pt]{article}')
  })

  it('标题 h1-h6 映射节命令', () => {
    const md = ['# 一', '## 二', '### 三', '#### 四', '##### 五', '###### 六'].join('\n\n')
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\section{一}')
    expect(body).toContain('\\subsection{二}')
    expect(body).toContain('\\subsubsection{三}')
    expect(body).toContain('\\paragraph{四}')
    expect(body).toContain('\\subparagraph{五}')
    expect(body).toContain('\\subparagraph{六}')
  })

  it('标题与正文中的 LaTeX 特殊字符被逃逸', () => {
    const body = bodyOf(renderLatexDocument('a_b & c % d# e$f', 't.md'))
    expect(body).toContain('a\\_b \\& c \\% d\\# e\\$f')
  })

  it('公式原文透传：行内与块级', () => {
    const md = '行内 $x^2 + y_1$ 公式\n\n$$\\frac{a}{b} + \\int_0^1 f(x)dx$$'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('$x^2 + y_1$')
    expect(body).toContain('$$\\frac{a}{b} + \\int_0^1 f(x)dx$$')
    // 公式内的下划线 / 花括号未被逃逸
    expect(body).not.toContain('\\$x^2')
    expect(body).not.toContain('y\\_1')
  })

  it('行内代码与围栏代码块', () => {
    const md = '行内 `code_here` 与代码块：\n\n```\nconst a = 1\n```\n'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\texttt{code\\_here}')
    expect(body).toContain('\\begin{verbatim}\nconst a = 1\n\\end{verbatim}')
  })

  it('围栏代码块内容含 \\end{verbatim} 时改用 lstlisting', () => {
    const md = '```\nx\n\\end{verbatim}\n```\n'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\begin{lstlisting}\nx\n\\end{verbatim}\n\\end{lstlisting}')
  })

  it('mermaid 代码块降级为注释保留源码', () => {
    const md = '```mermaid\ngraph TD\n  A --> B\n```\n'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('% [TMD] Mermaid 图表无法直接转为 LaTeX')
    expect(body).toContain('% graph TD')
    expect(body).toContain('%   A --> B')
    expect(body).not.toContain('\\begin{verbatim}')
  })

  it('无序列表与嵌套列表 → itemize 嵌套', () => {
    const md = '- 甲\n- 乙\n  - 乙一\n- 丙'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body.match(/\\begin\{itemize\}/g)?.length).toBe(2)
    expect(body.match(/\\end\{itemize\}/g)?.length).toBe(2)
    expect(body).toContain('\\item{} 甲')
    expect(body).toContain('\\item{} 乙一')
    // 嵌套子列表出现在乙之后（乙的 item 内容里）
    expect(body.indexOf('\\item{} 乙一')).toBeGreaterThan(body.indexOf('\\item{} 乙'))
  })

  it('有序列表 → enumerate', () => {
    const body = bodyOf(renderLatexDocument('1. 第一\n2. 第二', 't.md'))
    expect(body).toContain('\\begin{enumerate}')
    expect(body).toContain('\\item{} 第一')
    expect(body).toContain('\\end{enumerate}')
  })

  it('任务列表 [x] 不被解析为 item 可选参数', () => {
    const body = bodyOf(renderLatexDocument('- [x] 已完成项', 't.md'))
    expect(body).toContain('\\item{} [x] 已完成项')
  })

  it('引用块 → quote 环境', () => {
    const body = bodyOf(renderLatexDocument('> 引用内容', 't.md'))
    expect(body).toContain('\\begin{quote}')
    expect(body).toContain('引用内容')
    expect(body).toContain('\\end{quote}')
  })

  it('水平线 → \rule', () => {
    const body = bodyOf(renderLatexDocument('上\n\n---\n\n下', 't.md'))
    expect(body).toContain('\\noindent\\rule{\\linewidth}{0.4pt}')
  })

  it('外链生成 href；相对路径链接退化为纯文本', () => {
    const md = '[官网](https://example.com) 与 [本地](./other.md)'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\href{https://example.com}{官网}')
    expect(body).toContain('本地')
    expect(body).not.toContain('\\href{./other.md}')
  })

  it('图片：includegraphics + detokenize + 宽度（TMD 存储的 img 形式）', () => {
    const md = '正文 <img src="assets/my file.png" width="300"> 结尾'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\includegraphics[width=300px]{\\detokenize{assets/my file.png}}')
  })

  it('脚注：引用处内联 \footnote，定义块不重复输出', () => {
    const md = '正文有脚注[^1]。\n\n[^1]: 这里是脚注内容'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\footnote{这里是脚注内容}')
    expect(body.indexOf('这里是脚注内容')).toBe(body.lastIndexOf('这里是脚注内容'))
  })

  it('表格：对齐映射 longtable 列格式，单元格逃逸', () => {
    const md = ['| 左 | 中 | 右 |', '| --- | :-: | --: |', '| a_1 | b_c | c# |'].join('\n')
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\begin{longtable}[]{@{}l c r@{}}')
    expect(body).toContain('a\\_1 & b\\_c & c\\# \\\\')
    expect(body).toContain('\\toprule')
    expect(body).toContain('\\bottomrule')
  })

  it('高亮 / 下标 / 上标 / 删除线映射对应命令', () => {
    const md = '==高亮== 与 ~下标~ 与 ^上标^ 与 ~~删除~~ 与 **粗体** 与 *斜体*'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).toContain('\\colorbox{yellow}{高亮}')
    expect(body).toContain('\\textsubscript{下标}')
    expect(body).toContain('\\textsuperscript{上标}')
    expect(body).toContain('\\sout{删除}')
    expect(body).toContain('\\textbf{粗体}')
    expect(body).toContain('\\textit{斜体}')
  })

  it('图片：相对路径按文档目录展开为绝对路径', () => {
    const body = bodyOf(renderLatexDocument('![](assets/a.png)', 't.md', '/Users/x/docs'))
    expect(body).toContain('/Users/x/docs/assets/a.png')
  })

  it('图片：已是绝对路径或文档未保存时保持原样', () => {
    const abs = bodyOf(renderLatexDocument('![](/abs/a.png)', 't.md', '/Users/x/docs'))
    expect(abs).toContain('/abs/a.png')
    const noDir = bodyOf(renderLatexDocument('![](assets/a.png)', 't.md'))
    expect(noDir).toContain('assets/a.png')
  })

  it('front matter 剥离，TOC 注释标记行移除', () => {
    const md = '---\ntitle: 元信息\n---\n\n<!-- TOC -->\n\n- [a](#a)\n\n正文'
    const body = bodyOf(renderLatexDocument(md, 't.md'))
    expect(body).not.toContain('title: 元信息')
    expect(body).not.toContain('<!-- TOC -->')
    expect(body).toContain('正文')
  })
})

describe('assembleLatexDocument', () => {
  it('正文首尾空白被裁剪，文档结构完整', () => {
    const tex = assembleLatexDocument('  \n\\section{x}\n', 't.md')
    expect(tex).toContain('\\begin{document}\n\\section{x}\n\\end{document}')
  })
})
