/**
 * 原生 HTML 白名单清洗。
 *
 * 独立成模块的原因：sanitize-html（压缩后约 550KB）不能进主窗口启动路径。
 * 消费者两类——
 *  - 导出链（export-doc）：本模块被静态导入，随导出 chunk 懒加载，渲染规则
 *    保持同步语义；
 *  - 编辑器 raw-html.ts 的 html_block NodeView：经动态 import 懒加载本模块，
 *    就绪前显示占位（见 raw-html.ts）。
 * 文档模型全程存原始 HTML，清洗只影响显示层，parse/serialize 往返不经过
 * 本模块。
 *
 * @author chiangyang
 */
import sanitizeHtml from 'sanitize-html'

/** 允许渲染的标签：覆盖常见文档结构；script/style/iframe/svg 等一律剔除 */
const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
]

/**
 * 白名单清洗：去掉脚本/事件处理器/样式/class/id，只保留安全结构与少量
 * 展示属性。href/src 走协议白名单（img 额外允许 data:image）。
 */
export function sanitizeRawHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'align'],
      td: ['colspan', 'rowspan', 'align'],
      th: ['colspan', 'rowspan', 'align', 'scope'],
      ol: ['start', 'type'],
      details: ['open'],
      '*': ['title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // 不保留 HTML 注释（TOC 标记在更早的 remark 插件里已成为 toc 节点）
    allowedIframeHostnames: [],
  })
}
