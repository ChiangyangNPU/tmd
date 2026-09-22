/**
 * 导出文档核心：与载体无关的 Markdown → 文档中间表示。
 *
 * 三种导出载体共用同一份渲染产物与样式：
 * - 独立 HTML 文件（export.ts：CDN 外壳）
 * - Word 文档（export-word.ts：离屏页内 OOXML 转换）
 * - 长图（export-image.ts：离屏页内整页截图）
 *
 * 本模块不依赖 Electron / DOM 副作用（collectThemeVars 除外，仅主窗口采集时调用），
 * 纯函数部分均可在 vitest（node 环境）下直接断言。
 *
 * @author chiangyang
 */
import MarkdownIt from 'markdown-it'
import type { StateInline, Token } from 'markdown-it'
import footnote from 'markdown-it-footnote'
import markPlugin from 'markdown-it-mark'
import subPlugin from 'markdown-it-sub'
import supPlugin from 'markdown-it-sup'
import { getLocale } from './i18n'
import { slugify } from './toc'
import { parseImgHtml } from './image-attrs'
import { toFileUrl } from './fs-path'

/**
 * 解析管线工厂：与渲染目标无关的解析权威。
 *
 * 插件集（脚注 / 高亮 / 上下标）、公式保护规则（tmd_math 整段保留原文）、
 * 图片 HTML 还原（tmdConvertImgHtml）只与「怎么解析」有关，与「渲染成什么」
 * 无关——HTML 与 LaTeX 两种渲染目标各自创建实例，共享同一套解析行为。
 * 渲染规则（HTML 的 fence/heading/image 等）不属于本工厂，由各渲染目标
 * 在自己的实例上安装。
 */
export function createExportMarkdownIt() {
  const md = new MarkdownIt({ html: false, linkify: true })
    .use(footnote)
    .use(markPlugin)
    .use(subPlugin)
    .use(supPlugin)
  md.inline.ruler.before('text', 'tmd_math', mathRule)
  md.core.ruler.push('tmdConvertImgHtml', (state) => convertImgTokens(state.tokens))
  return md
}

const mdIt = createExportMarkdownIt()

/** $ 的字符码 */
const DOLLAR = 0x24

/**
 * 从 from 起查找未被反斜杠转义的 delim 位置；找不到返回 -1。
 *
 * 公式内容里的 `\$` 是字面美元符，不能当作闭合分隔符，否则 `$a \$ b$`
 * 会在 `\$` 处提前截断成非法公式。前面连续反斜杠为偶数个才算未转义。
 */
function findUnescapedDelim(src: string, delim: string, from: number): number {
  const BACKSLASH = 0x5c
  let idx = src.indexOf(delim, from)
  while (idx !== -1) {
    let backslashes = 0
    for (let i = idx - 1; i >= 0 && src.charCodeAt(i) === BACKSLASH; i--) backslashes++
    if (backslashes % 2 === 0) return idx
    idx = src.indexOf(delim, idx + 1)
  }
  return -1
}

/**
 * 公式保护内联规则：把 `$$…$$` / `$…$` 整段按原文保留为一个文本 token。
 *
 * 必须早于其他内联规则生效，否则 LaTeX 原文会被二次解释：
 * - markdown-it 的转义规则把 `\,` 吞成 `,`（间距命令丢失）
 * - 上/下标插件把 `x^{2}` 变成 `x<sup>{2}</sup>`（花括号被切断）
 * 公式因此无法被 KaTeX 正确解析，在 HTML / Word / 长图三条导出路径上同时失真。
 * 保留原文后交给 KaTeX（CDN auto-render 或离屏页本地渲染）解析。
 *
 * 判定规则（与常见 Markdown 编辑器一致）：
 * - `$$…$$` 允许跨行，内容非空
 * - `$…$` 不跨行、内容非空且首尾无空白，避免把「价格 $5 与 $6」误判为公式
 * - 闭合分隔符跳过被转义的 `\$`（见 findUnescapedDelim）
 */
function mathRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== DOLLAR) return false
  const isDisplay = state.src.charCodeAt(start + 1) === DOLLAR
  const delim = isDisplay ? '$$' : '$'
  const from = start + delim.length
  const close = findUnescapedDelim(state.src, delim, from)
  if (close < 0 || close + delim.length > state.posMax) return false
  const content = state.src.slice(from, close)
  if (content === '') return false
  if (!isDisplay && (/[\n]/.test(content) || /^\s|\s$/.test(content))) return false
  if (!silent) {
    // 独立 token 类型：text_join 核心规则会把相邻 text token 合并（meta 丢失），
    // 故不推 text 而推 math_inline——各渲染目标按需安装规则
    const token = state.push('math_inline', '', 0)
    token.content = state.src.slice(start, close + delim.length)
    // 标记公式原文：LaTeX 渲染目标据此透传（其余 text token 需逃逸特殊字符）
    token.meta = { math: true }
  }
  state.pos = close + delim.length
  return true
}

/** 匹配 text token 中的 <img ...> 标签（html:false 下 markdown-it 把行内 HTML 归为 text） */
const IMG_TOKEN_RE = /<img\s[^<>]*>/gi

/** 构造 markdown-it image token（markdown-it 15 不导出 Token 类，
 *  借同流真实 token 的原型挂方法，attrGet/attrIndex 随原型可用） */
function makeImgToken(m: RegExpExecArray, sample: Token): Token | null {
  const attrs = parseImgHtml(m[0])
  if (!attrs) return null
  const pairs: [string, string][] = [
    ['src', attrs.src],
    ['alt', attrs.alt ?? ''],
  ]
  if (attrs.title) pairs.push(['title', attrs.title])
  if (attrs.width != null) pairs.push(['width', String(attrs.width)])
  if (attrs.align) pairs.push(['align', attrs.align])
  // children 置 null：真实 image token 的 children 恒为数组，据此识别合成 token
  // （渲染路径走自定义规则，避免默认规则用 renderInlineAsText(children) 覆盖 alt）
  return Object.assign(Object.create(Object.getPrototypeOf(sample)), {
    type: 'image',
    tag: 'img',
    nesting: 0,
    attrs: pairs,
    children: null,
    content: '',
    markup: '',
    info: '',
    meta: null,
    block: false,
    hidden: false,
    level: 0,
    map: null,
  }) as unknown as Token
}

/** 克隆 text token 并改写 content（原型链保留 attrGet 等方法供渲染器调用） */
function cloneTextToken(src: Token, content: string): Token {
  return Object.assign(Object.create(src), { content }) as Token
}

/**
 * 把 inline token children 里 text 形态的 <img ...> 标签转换为 image token
 * （导出管线 html:false 会把 HTML 转义为可见文本，特此还原为真实图片）。
 * 非图片文本原样保留；src 不安全或无缩放属性的标签维持原状（安全兜底）。
 * 导出供单元测试覆盖。
 */
export function convertImgTokens(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const children = token.children
    const next: Token[] = []
    for (const child of children) {
      if (child.type !== 'text' || !/<img\s/i.test(child.content)) {
        next.push(child)
        continue
      }
      const parts: Token[] = []
      let last = 0
      let childChanged = false
      for (const m of child.content.matchAll(IMG_TOKEN_RE)) {
        const img = makeImgToken(m, child)
        if (!img) continue // 解析失败（非安全 src 等）：该标签保持文本
        if (m.index > last) {
          parts.push(cloneTextToken(child, child.content.slice(last, m.index)))
        }
        parts.push(img)
        last = m.index + m[0].length
        childChanged = true
      }
      if (!childChanged) {
        next.push(child)
        continue
      }
      if (last < child.content.length) {
        parts.push(cloneTextToken(child, child.content.slice(last)))
      }
      next.push(...parts)
    }
    token.children = next
  }
}

/**
 * 公式行内规则（HTML 路径）：math_inline token 按 HTML 转义输出原文本，
 * 公式渲染交给消费方（CDN auto-render 或离屏页 KaTeX）。
 * 注意必须显式安装——否则渲染白名单/默认规则不知道如何处理自定义类型。
 */
mdIt.renderer.rules.math_inline = (tokens, idx) => mdIt.utils.escapeHtml(tokens[idx].content)

/**
 * 图片渲染混合规则：convertImgTokens 产出的合成 token 以 children === null 标记
 * （真实 image token 的 children 恒为数组），按 attrs 直接渲染——markdown-it 15
 * 默认 image 规则会无条件用 renderInlineAsText(children) 覆盖 alt，不能委托；
 * 原生 ![alt](src) 的真 Token 委托默认规则保持行为一致。
 */
const defaultImageRule =
  mdIt.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
mdIt.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token.children === null) {
    // attrGet 的官方类型为 string | number | null（本处 attrs 全为 string），归一后转义
    const get = (name: string) => {
      const v = token.attrGet(name)
      return v == null ? '' : String(v)
    }
    const esc = (s: string) => mdIt.utils.escapeHtml(s)
    let html = `<img src="${esc(get('src'))}" alt="${esc(get('alt'))}"`
    if (get('title')) html += ` title="${esc(get('title'))}"`
    if (get('width')) html += ` width="${esc(get('width'))}"`
    if (get('align')) html += ` align="${esc(get('align'))}"`
    return `${html}>`
  }
  return defaultImageRule(tokens, idx, options, env, self)
}

/**
 * 导出页消费的主题变量名（与 style.css 内建配色同名）。
 * 值由 collectThemeVars 在导出瞬间抓取，经 :root 注入后此处以 var() 消费——
 * 深浅模式、主题预设、自定义 CSS 改过的变量自动跟随；
 * fallback 为默认浅色值，快照缺失时行为与旧版写死浅色一致。
 */
const THEME_VAR_NAMES = [
  '--bg',
  '--fg',
  '--muted',
  '--border',
  '--accent',
  '--code-bg',
  '--pre-bg',
  '--quote-bg',
] as const

/** 变量名到导出页值的映射（纯函数，便于单测） */
export function buildThemeVarsBlock(vars: Record<string, string>): string {
  const lines = THEME_VAR_NAMES.filter((name) => vars[name]).map(
    (name) => `  ${name}: ${vars[name]};`,
  )
  return `:root {\n${lines.join('\n')}\n}`
}

/** 导出 CSS：颜色全部走 var()，兜底默认浅色 */
export const EXPORT_CSS = `
  body { max-width: 860px; margin: 0 auto; padding: 48px 32px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: var(--fg, #24292f); background: var(--bg, #ffffff); line-height: 1.75; }
  a { color: var(--accent, #4a7cd4); }
  h1, h2, h3, h4 { font-weight: 600; line-height: 1.3; }
  blockquote { margin: 0; padding: 4px 16px; border-left: 4px solid var(--accent, #4a7cd4);
    color: var(--muted, #6a737d); background: var(--quote-bg, transparent); }
  code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.88em;
    background: var(--code-bg, #f3f4f6); border-radius: 4px; padding: 2px 5px; }
  pre { background: var(--pre-bg, #f6f8fa); border: 1px solid var(--border, #e2e6ea);
    border-radius: 8px; padding: 12px 16px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--border, #e2e6ea); padding: 6px 12px; text-align: left; }
  th { background: var(--pre-bg, #f6f8fa); }
  img { max-width: 100%; }
  img[align='center'] { display: block; margin: 0 auto; }
  img[align='left'] { display: block; margin-right: auto; }
  img[align='right'] { display: block; margin-left: auto; }
  .mermaid { display: flex; justify-content: center; }
  mark { background: rgba(255, 213, 0, .35); border-radius: 3px; padding: 0 2px; }
  sub, sup { font-size: 0.75em; }
  .footnotes-sep { margin: 2.5em 0 1em; border: 0;
    border-top: 1px solid var(--border, #e2e6ea); }
  .footnotes { font-size: 0.9em; color: var(--muted, #6a737d); }
  .footnotes-list { padding-left: 1.6em; }
  .footnote-ref a, .footnote-backref { text-decoration: none; }
  .footnote-item p { margin: 0.3em 0; }
`

/**
 * 抓取当前已解析的主题变量快照（导出瞬间从 documentElement 计算）：
 * 深浅模式、预设、自定义 CSS 的变量覆盖都会体现在计算值里
 */
export function collectThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of THEME_VAR_NAMES) {
    const v = cs.getPropertyValue(name).trim()
    if (v) vars[name] = v
  }
  return vars
}

/** inline token 结构（markdown-it token 子集，仅保留导出所需的字段） */
type InlineToken = { type: string; content?: string; children?: InlineToken[] }

/**
 * 递归提取 inline token 的渲染纯文本。
 * image 的 alt 不计入，与 ProseMirror 的 textContent 行为对齐。
 * @param token - 待提取的 inline token
 * @returns 拼接后的纯文本
 */
function inlineText(token: InlineToken): string {
  if (token.type === 'text' || token.type === 'code_inline') return token.content ?? ''
  if (token.type === 'image') return ''
  return (token.children ?? []).map(inlineText).join('')
}

/**
 * 剥离文档起始的 YAML front matter（--- 围栏块）。
 * 元数据不进入导出成稿（与 .md 源文件保留无关，编辑器保存时原样写回）；
 * 只认文档第一行起的围栏，正文中间的 --- 仍是分隔线/Setext 下划线，不动。
 * 围栏内容还需至少含一行 YAML 键值（`key: value`），否则文档开头的
 * 「--- 水平线 + 段落 + --- 水平线」会被整块吞掉，导出正文丢失。
 * 导出供单元测试覆盖。
 */
export function stripFrontMatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return markdown
  if (!/^[ \t]*[^\s:][^:\n]*:[ \t]*\S/m.test(match[1])) return markdown
  return markdown.slice(match[0].length)
}

/**
 * 导出源准备（各渲染目标共用的前置清理）：
 * - 剥离 front matter（元数据不进导出成稿，源文件保存不受影响）
 * - 删除 TOC 注释标记行（保留中间真实链接列表）；兼容行首可能的转义反斜杠
 *   （remark-stringify 防 HTML 转义产物）
 */
export function prepareExportSource(markdown: string): string {
  return stripFrontMatter(markdown).replace(/^[ \t]*\\?<!--\s*\/?TOC\s*-->[ \t]*$/gm, '')
}

/** fence 规则是否已安装：本模块的 mdIt 为单例，重复包装会让规则层层嵌套 */
let fenceRuleInstalled = false

/** 安装 ```mermaid → <pre class="mermaid"> 的 fence 规则（幂等，只装一次） */
function ensureFenceRule() {
  if (fenceRuleInstalled) return
  fenceRuleInstalled = true
  const fence =
    mdIt.renderer.rules.fence ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  mdIt.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (token.info.trim() === 'mermaid') {
      return `<pre class="mermaid">${mdIt.utils.escapeHtml(token.content)}</pre>\n`
    }
    return fence(tokens, idx, options, env, self)
  }
}

/**
 * 渲染 markdown 为导出页正文 HTML（走内部 mdIt 实例：含图片 token 还原与渲染规则）：
 * - ```mermaid 代码块 → <pre class="mermaid">，由消费方（CDN 脚本或离屏页本地 mermaid）渲染
 * - TOC 注释标记行删除（保留中间真实链接列表，正常渲染为可点目录）
 * - 标题加 GitHub 风格 id 锚点（与编辑器内 TOC 链接的 slug 规则一致）
 * 导出供单测。
 */
export function renderMarkdown(markdown: string): string {
  ensureFenceRule()

  // 同名标题计数：第一个为 slug，其后为 slug-1、slug-2（与 toc.ts collectHeadings 一致）
  const slugCount = new Map<string, number>()
  mdIt.renderer.rules.heading_open = (tokens, idx) => {
    const token = tokens[idx]
    const inline = tokens[idx + 1] as InlineToken | undefined
    const text = inline && inline.type === 'inline' ? inlineText(inline) : ''
    // 空标题也要有可用锚点：slugify('') 得空串会让多个空标题共用 id=""
    let slug = slugify(text) || 'heading'
    const seen = slugCount.get(slug) ?? 0
    slugCount.set(slug, seen + 1)
    if (seen > 0) slug = `${slug}-${seen}`
    return `<${token.tag} id="${mdIt.utils.escapeHtml(slug)}">`
  }

  // html:false 时注释会被转义成可见文本，直接移除 TOC 标记行（列表保留）；
  // front matter 属元数据，导出成稿中剥离（源文件保存不受影响）
  const cleaned = prepareExportSource(markdown)
  return mdIt.render(cleaned)
}

/**
 * 导出文档（载体无关的中间表示）：
 * Markdown 渲染正文 + 主题变量快照 + 导出样式表 + 语言/深浅/标题元信息。
 * HTML 外壳、Word 转换、长图截图三种载体各自消费，杜绝三处重复渲染。
 */
export interface ExportDocument {
  /** 文档语言（HTML 的 <html lang> / Word 拼写检查语言） */
  lang: string
  /** 文档标题（已去 .md 后缀） */
  title: string
  /** 正文 HTML（mermaid 为 <pre class="mermaid"> 占位，公式为 $...$ 文本，由消费方渲染） */
  bodyHtml: string
  /** :root 主题变量快照块（已含 <style> 标签由消费方自行包裹或作为文本节点） */
  varsBlock: string
  /** 导出样式表原文 */
  css: string
  /** 当前是否深色模式（mermaid 主题等随动） */
  isDark: boolean
}

/** 组装导出文档中间表示（纯函数） */
export function buildExportDocument(
  markdown: string,
  currentName: string,
  vars: Record<string, string>,
  isDark: boolean,
): ExportDocument {
  return {
    lang: getLocale(),
    title: currentName.replace(/\.md$/i, ''),
    bodyHtml: renderMarkdown(markdown),
    varsBlock: buildThemeVarsBlock(vars),
    css: EXPORT_CSS,
    isDark,
  }
}

/**
 * 导出图片引用分类（纯函数，不触碰文件系统）。
 *
 * 离屏页与主窗口不同源，blob: 与相对路径都不能直接加载：
 * - data: 已内嵌，任何环境可用
 * - http(s) 远程图片，离屏页直接加载（专用 CSP 放行 https）
 * - file: 或相对路径解析出的本地图片，由主进程 read-image 原语读盘转 data URI
 * - 空值 / 危险协议（javascript: 等）/ blob:（跨页失效）一律阻断，留 alt 文本
 *
 * @param src - 正文 HTML 中 <img> 的原始 src
 * @param baseDir - 当前文档所在目录绝对路径；未保存文档为 null
 */
export type ExportImageRef =
  | { kind: 'embedded' }
  | { kind: 'remote'; src: string }
  | { kind: 'local'; fileUrl: string }
  | { kind: 'blocked' }

/** 危险协议前缀（javascript:/vbscript:/data: 非图片场景等，图片只放行白名单形态） */
const UNSAFE_PROTOCOL_RE = /^(javascript|vbscript|file):/i

export function resolveExportImageRef(src: unknown, baseDir: string | null): ExportImageRef {
  if (typeof src !== 'string') return { kind: 'blocked' }
  const s = src.trim()
  if (!s) return { kind: 'blocked' }
  if (s.startsWith('data:')) return { kind: 'embedded' }
  if (/^https?:/i.test(s)) return { kind: 'remote', src: s }
  // blob: 由主窗口 URL.createObjectURL 产生，跨页面/跨进程必然失效
  if (s.startsWith('blob:')) return { kind: 'blocked' }
  if (s.startsWith('file:')) {
    // 已成形的 file: URL 仍需主进程读盘（离屏页无 file 协议权限）
    return { kind: 'local', fileUrl: s }
  }
  // 根相对路径（/Users/... 由 http 页面语义会指向导出页自身源）与协议相对路径不支持
  if (s.startsWith('/') || s.startsWith('//')) return { kind: 'blocked' }
  if (UNSAFE_PROTOCOL_RE.test(s)) return { kind: 'blocked' }
  // 其余视为相对路径：未保存文档（无目录）无法定位
  if (!baseDir) return { kind: 'blocked' }
  return { kind: 'local', fileUrl: toFileUrl(baseDir, s) }
}
