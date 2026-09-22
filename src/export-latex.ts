/**
 * LaTeX 导出适配器：markdown-it token 流 → 独立可编译的 .tex 源文件。
 *
 * 架构位置与 export-word / export-image 同构（载体适配器）：解析权威在
 * export-doc（createExportMarkdownIt 工厂，与 HTML 共享插件集 / 公式保护 /
 * 图片还原），本模块只做「token 流 → LaTeX」的渲染与文档组装——纯函数、
 * 零 Electron / DOM 依赖，可整体被 vitest 覆盖（导出供单测）。
 *
 * 设计要点：
 * - **渲染白名单**：renderer.renderToken 兜底置空——未显式安装规则的 token
 *   零输出，杜绝 markdown-it 默认 HTML 渲染漏进 .tex
 * - **公式零失真**：tmd_math 规则保留的原文 token 带 meta.math 标记，
 *   LaTeX 是公式的原生表达，透传不逃逸
 * - **捕获栈**：表格单元格与脚注定义的内容经 env.captures 收集后组装
 *   （longtable 行 / \footnote 内联），内容类规则统一经 out() 写入栈顶
 * - **降级策略**：Mermaid 图表无离线 LaTeX 方案，降级为注释保留图表源码；
 *   非外链与无 src 图片退化为纯文本 / alt
 * - **中文**：正文含 CJK 时用 ctexart（XeLaTeX），纯西文用 article，
 *   首行 magic comment（% !TEX program = xelatex）供编辑器识别
 *
 * @author chiangyang
 */
import type { Token } from 'markdown-it'
import { createExportMarkdownIt, prepareExportSource } from './export-doc'
import { isWindowsPath } from './fs-path'

// ---------------------------------------------------------------------------
// LaTeX 特殊字符逃逸
// ---------------------------------------------------------------------------

/**
 * LaTeX 特殊字符逃逸（文本上下文；公式 / 代码 / verbatim 内容不经过此函数）。
 * 单遍扫描替换：不引入占位符，因此结果与输入内容无关
 * （旧实现用 Unicode 私用区字符充当反斜杠占位符，输入含相同字符时会被误改写）。
 */
export function escapeLatex(text: string): string {
  const MAP: Record<string, string> = {
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    $: '\\$',
    '%': '\\%',
    '&': '\\&',
    '#': '\\#',
    _: '\\_',
    '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
    '<': '\\textless{}',
    '>': '\\textgreater{}',
    '|': '\\textbar{}',
  }
  return text.replace(/[\\{}$%&#_~^<>|]/g, (ch) => MAP[ch] ?? ch)
}

/**
 * 图片路径解析：相对路径按当前文档目录展开为绝对路径。
 *
 * .tex 常被保存到文档目录之外，保留相对路径会让 XeLaTeX 找不到图片
 * （Word / 长图管线有 localizeImages 内联图片，LaTeX 侧无等价步骤）；
 * 文档未保存（无目录）时保持原样，交由用户自行调整。
 */
function resolveImagePath(src: string, baseDir: string | null): string {
  if (!baseDir) return src
  if (src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src)) return src
  const sep = isWindowsPath(baseDir) ? '\\' : '/'
  return `${baseDir.replace(/[\\/]+$/, '')}${sep}${src.replace(/^[\\/]+/, '')}`
}

/** 正文是否含中日韩文字（决定文档类：ctexart 需支持中文的 XeLaTeX 环境） */
export function containsCJK(text: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)
}

// ---------------------------------------------------------------------------
// LaTeX 渲染器：token 规则（白名单）+ env 状态
// ---------------------------------------------------------------------------

/** 标题层级 → 节命令（h6 与 h5 同用 \subparagraph，LaTeX 无更深层级） */
const HEADING_COMMANDS: Record<string, string> = {
  h1: '\\section',
  h2: '\\subsection',
  h3: '\\subsubsection',
  h4: '\\paragraph',
  h5: '\\subparagraph',
  h6: '\\subparagraph',
}

interface LatexTableState {
  aligns: string[]
  head: string[]
  body: string[]
  row: string[]
  inHead: boolean
}

interface LatexEnv {
  listDepth: number
  /** 链接 href 栈：外链存 href（link_close 收口 \href），非外链存 null（退化为纯文本） */
  linkStack: (string | null)[]
  /** 内容捕获栈：表格单元格 / 脚注定义（非空时所有内容进栈顶片段数组，不直接输出） */
  captures: string[][]
  footnoteTexts: Map<string, string>
  table: LatexTableState | null
  /** 当前文档目录：相对路径图片据此展开为绝对路径（.tex 常被存到别处） */
  baseDir: string | null
}

function createLatexEnv(baseDir: string | null = null): LatexEnv {
  return {
    listDepth: 0,
    linkStack: [],
    captures: [],
    footnoteTexts: new Map(),
    table: null,
    baseDir,
  }
}

/** 输出通道：捕获栈非空时内容进栈顶（表格单元格 / 脚注定义），否则直接输出 */
function out(env: LatexEnv, s: string): string {
  if (env.captures.length) {
    env.captures[env.captures.length - 1].push(s)
    return ''
  }
  return s
}

/** 给定对齐样式（markdown-it 的 style="text-align:center"）→ LaTeX 列格式字母 */
function alignToColumn(style: string | number | null): string {
  const s = style == null ? '' : String(style)
  if (/center/.test(s)) return 'c'
  if (/right/.test(s)) return 'r'
  return 'l'
}

/** 安装 LaTeX 渲染规则（白名单：未安装规则的 token 一律零输出） */
function installLatexRules(md: ReturnType<typeof createExportMarkdownIt>, env: LatexEnv): void {
  const rules = md.renderer.rules

  // ---- 文本与行内代码 ----
  rules.text = (tokens, idx) => out(env, escapeLatex(tokens[idx].content))
  // tmd_math 保留的公式原文：LaTeX 是公式的原生表达，透传不逃逸
  rules.math_inline = (tokens, idx) => out(env, tokens[idx].content)
  rules.code_inline = (tokens, idx) => out(env, `\\texttt{${escapeLatex(tokens[idx].content)}}`)

  // ---- 代码块（fence 与缩进代码块）；含 \end{verbatim} 的内容改用 lstlisting ----
  const emitCode = (content: string): string => {
    const body = content.replace(/\n$/, '') // fence 内容的尾随换行由环境收口
    if (body.includes('\\end{verbatim}')) {
      return `\n\\begin{lstlisting}\n${body}\n\\end{lstlisting}\n`
    }
    return `\n\\begin{verbatim}\n${body}\n\\end{verbatim}\n`
  }
  rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    if (token.info.trim() === 'mermaid') {
      // Mermaid 无离线 LaTeX 方案：降级为注释，图表源码逐行保留不丢失
      const commented = token.content
        .split('\n')
        .map((line) => `% ${line}`)
        .join('\n')
      return `\n% [TMD] Mermaid 图表无法直接转为 LaTeX，以下保留图表源码（可经 Mermaid CLI 渲染为图片后插入）：\n% \`\`\`mermaid\n${commented}\n% \`\`\`\n`
    }
    return emitCode(token.content)
  }
  rules.code_block = (tokens, idx) => emitCode(tokens[idx].content)

  // ---- 标题（h1-h6 → section..subparagraph；内容在 open/close 之间渲染）----
  rules.heading_open = (tokens, idx) => `${HEADING_COMMANDS[tokens[idx].tag] ?? '\\subparagraph'}{`
  rules.heading_close = () => '}\n'

  // ---- 段落：列表与捕获上下文内不输出段落分隔空行 ----
  rules.paragraph_open = () => (env.listDepth > 0 || env.captures.length ? '' : '\n')
  rules.paragraph_close = () => (env.listDepth > 0 || env.captures.length ? '' : '\n')

  // ---- 列表（支持嵌套：itemize / enumerate 递归包裹）----
  rules.bullet_list_open = () => {
    env.listDepth++
    return '\n\\begin{itemize}\n'
  }
  rules.bullet_list_close = () => {
    env.listDepth--
    return '\\end{itemize}\n'
  }
  rules.ordered_list_open = () => {
    env.listDepth++
    return '\n\\begin{enumerate}\n'
  }
  rules.ordered_list_close = () => {
    env.listDepth--
    return '\\end{enumerate}\n'
  }
  // \item{} 的空组阻断紧随其后的 [..] 被解析为可选参数（任务列表「[x] 」场景）
  rules.list_item_open = () => '\\item{} '
  rules.list_item_close = () => ''

  // ---- 引用块 ----
  rules.blockquote_open = () => '\n\\begin{quote}\n'
  rules.blockquote_close = () => '\n\\end{quote}\n'

  // ---- 水平线 ----
  rules.hr = () => '\n\\noindent\\rule{\\linewidth}{0.4pt}\n'

  // ---- 换行 ----
  rules.softbreak = () => '\n'
  rules.hardbreak = () => '\\\\\n'

  // ---- 链接：仅外链（http/https/mailto）生成 \href，其余退化为纯文本 ----
  rules.link_open = (tokens, idx) => {
    // attrGet 官方类型为 string | number | null（本处 attrs 全为 string），归一后使用
    const raw = tokens[idx].attrGet('href')
    const href = raw == null ? null : String(raw)
    const external = href != null && /^(https?:|mailto:)/i.test(href)
    env.linkStack.push(external ? href : null)
    return external ? `\\href{${escapeLatex(href ?? '')}}{` : ''
  }
  rules.link_close = () => {
    const href = env.linkStack.pop()
    return href != null ? '}' : ''
  }

  // ---- 图片：\includegraphics + \detokenize（路径含空格等特殊字符仍可编译）----
  rules.image = (tokens, idx) => {
    const token = tokens[idx]
    // attrGet 官方类型为 string | number | null（本处 attrs 全为 string），归一后使用
    const get = (name: string) => {
      const v = token.attrGet(name)
      return v == null ? '' : String(v)
    }
    const src = get('src')
    const width = get('width')
    const alt = get('alt')
    if (!src) return out(env, escapeLatex(alt))
    const opt = width ? `[width=${escapeLatex(width)}px]` : ''
    const path = resolveImagePath(src, env.baseDir)
    return out(env, `\\includegraphics${opt}{\\detokenize{${escapeLatex(path)}}}`)
  }

  // ---- 脚注引用：定义内容已在预扫描阶段按 id 收集 ----
  rules.footnote_ref = (tokens, idx) => {
    const id = String(tokens[idx].meta?.id ?? '')
    return out(env, `\\footnote{${env.footnoteTexts.get(id) ?? ''}}`)
  }

  // ---- 脚注定义块：内容已在引用处内联，渲染期整块丢弃（防重复输出）----
  rules.footnote_block_open = () => ''
  rules.footnote_block_close = () => ''
  rules.footnote_open = () => {
    env.captures.push([])
    return ''
  }
  rules.footnote_close = () => {
    env.captures.pop()
    return ''
  }
  rules.footnote_anchor = () => ''

  // ---- 语法扩展：高亮 / 上下标 ----
  rules.mark_open = () => '\\colorbox{yellow}{'
  rules.mark_close = () => '}'
  rules.sub_open = () => '\\textsubscript{'
  rules.sub_close = () => '}'
  rules.sup_open = () => '\\textsuperscript{'
  rules.sup_close = () => '}'

  // ---- 强调 / 斜体 / 删除线（markdown-it 内建；ulem 的 \sout 做删除线）----
  rules.strong_open = () => '\\textbf{'
  rules.strong_close = () => '}'
  rules.em_open = () => '\\textit{'
  rules.em_close = () => '}'
  rules.s_open = () => '\\sout{'
  rules.s_close = () => '}'

  // ---- 表格：单元格内容经捕获栈收集，table_close 统一组装为 longtable ----
  rules.table_open = () => {
    env.table = { aligns: [], head: [], body: [], row: [], inHead: false }
    return ''
  }
  rules.thead_open = () => {
    if (env.table) env.table.inHead = true
    return ''
  }
  rules.thead_close = () => {
    if (env.table) env.table.inHead = false
    return ''
  }
  rules.tr_open = () => ''
  rules.tr_close = () => {
    if (!env.table) return ''
    const row = env.table.row.join(' & ')
    if (env.table.inHead) env.table.head.push(row)
    else env.table.body.push(row)
    env.table.row = []
    return ''
  }
  rules.th_open = (tokens, idx) => {
    if (!env.table) return ''
    env.table.aligns.push(alignToColumn(tokens[idx].attrGet('style')))
    env.captures.push([])
    return ''
  }
  rules.td_open = () => {
    env.captures.push([])
    return ''
  }
  const cellClose = (): string => {
    const cell = env.captures.pop() ?? []
    if (!env.table) return ''
    env.table.row.push(cell.join(''))
    return ''
  }
  rules.th_close = cellClose
  rules.td_close = cellClose
  rules.table_close = () => {
    const t = env.table
    env.table = null
    if (!t) return ''
    // aligns 在 th_open 时已是转换后的列格式字母（l/c/r），此处直接使用
    const spec = (t.aligns.length ? t.aligns : ['l']).join(' ')
    const lines = ['\n\\begin{longtable}[]{@{}' + spec + '@{}}', '\\toprule']
    lines.push(`${t.head.join(' & ')} \\\\`)
    lines.push('\\midrule')
    lines.push('\\endhead')
    for (const row of t.body) lines.push(`${row} \\\\`)
    lines.push('\\bottomrule')
    lines.push('\\end{longtable}\n')
    return lines.join('\n')
  }

  // ---- 兜底白名单：任何未显式安装规则的 token（markdown-it 默认按 HTML 渲染
  // 的 _open/_close 等）零输出，杜绝 HTML 片段漏进 .tex ----
  md.renderer.renderToken = () => ''
}

/**
 * 预扫描脚注定义：markdown-it-footnote 的定义块在引用之后渲染，
 * 而 LaTeX 的 \footnote 必须在引用处内联内容——先把 id → 内容收集进 env。
 */
function prescanFootnotes(
  tokens: Token[],
  pipeline: ReturnType<typeof createExportMarkdownIt>,
  env: LatexEnv,
): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'footnote_open') continue
    const id = String(tokens[i].meta?.id ?? '')
    const parts: string[] = []
    for (let j = i + 1; j < tokens.length && tokens[j].type !== 'footnote_close'; j++) {
      const t = tokens[j]
      if (t.type === 'inline' && t.children) {
        // env 传空对象即可：本模块的规则经闭包持有 env，不消费该参数
        parts.push(pipeline.renderer.renderInline(t.children, pipeline.options, {}))
      }
    }
    env.footnoteTexts.set(id, parts.join(' '))
  }
}

// ---------------------------------------------------------------------------
// 文档组装
// ---------------------------------------------------------------------------

/** 组装 .tex 文档（preamble + 正文）：正文含 CJK 时用 ctexart，纯西文用 article */
export function assembleLatexDocument(body: string, title: string): string {
  const docClass = containsCJK(body) ? 'ctexart' : 'article'
  return `% !TEX program = xelatex
% 由 TMD（Type Markdown, Done.）导出 — 请使用支持中文的 XeLaTeX 编译
% 文档标题：${escapeLatex(title)}
\\documentclass[12pt]{${docClass}}
\\usepackage{graphicx}
\\usepackage{longtable}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{xcolor}
\\usepackage[normalem]{ulem}
\\usepackage{hyperref}
\\hypersetup{colorlinks=true, urlcolor=blue, linkcolor=blue}
\\begin{document}
${body.trim()}
\\end{document}
`
}

/**
 * 导出 LaTeX 源码（纯函数）：
 * Markdown → 共享解析管线（公式保护 / 图片还原 / front matter 剥离）→
 * LaTeX 渲染规则 → 文档组装。
 * - 公式 $...$ / $$...$$ 原文透传（LaTeX 原生支持，零失真）
 * - Mermaid 图表降级为注释保留源码（无离线 LaTeX 方案，见模块头注释）
 * - 图片输出 \includegraphics：相对路径随 .tex 落点解析，远程图片需先下载
 */
export function renderLatexDocument(
  markdown: string,
  title: string,
  baseDir: string | null = null,
): string {
  const pipeline = createExportMarkdownIt()
  const env = createLatexEnv(baseDir)
  installLatexRules(pipeline, env)
  // env 参数对本模块规则无作用（规则经闭包持有 env），传空对象满足 Env 契约
  const tokens = pipeline.parse(prepareExportSource(markdown), {})
  prescanFootnotes(tokens, pipeline, env)
  const body = pipeline.renderer.render(tokens, pipeline.options, {})
  return assembleLatexDocument(body, title)
}
