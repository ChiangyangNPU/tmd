/**
 * Word 公式可编辑化：把独占公式由位图改为 OMML（Office Math Markup Language）。
 *
 * 为什么要后处理：HTML→docx 走的是 dom-docx，它不支持公式也没有 raw OOXML 扩展点，
 * 因此导出后直接改写 word/document.xml——把公式占位段落整段替换为 <m:oMathPara>。
 *
 * 链路：LaTeX 源码 →（KaTeX）MathML →（mathml2omml）OMML。
 * 任一环节失败时该段降级为居中显示的 LaTeX 源码文本（可复制进 Word 公式编辑器），
 * 绝不产出无法阅读的内容。
 *
 * @author chiangyang
 */
import katex from 'katex'
import { mml2omml } from 'mathml2omml'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** OOXML 数学命名空间（<m:oMath> 等元素所属） */
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
/** docx 内的正文部件路径 */
const DOCUMENT_PART = 'word/document.xml'
/** 排版命令里段落结束标签的长度（用于截断） */
const PARA_CLOSE = '</w:p>'

/**
 * 公式占位文本：形如 `@@TMDMATH0@@`。
 * 它作为普通段落文本进入 docx，导出后据此定位并整段替换为公式。
 * 用 `@@` 包裹是为了避免与正文里的自然文本撞车。
 */
export function mathPlaceholder(index: number): string {
  return `@@TMDMATH${index}@@`
}

/** XML 文本转义（仅用于降级段落的源码文本） */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * LaTeX → OMML。
 * @param tex - LaTeX 数学源码（不含 $ 定界符）
 * @returns OMML 字符串；KaTeX 渲染失败或转换器未产出 oMath 时返回 null
 */
export function latexToOmml(tex: string): string | null {
  if (!tex.trim()) return null
  try {
    // KaTeX 的 MathML 输出外面还包着 <span class="katex">，取其中的 <math> 子树
    const html = katex.renderToString(tex, {
      output: 'mathml',
      displayMode: true,
      throwOnError: true,
    })
    const mathml = /<math[\s\S]*<\/math>/.exec(html)?.[0]
    if (!mathml) return null
    const omml = mml2omml(mathml).trim()
    return omml.includes('<m:oMath') ? omml : null
  } catch {
    return null
  }
}

/** 公式段落：居中 + OMML 块（oMathPara 让公式独占一行并居中） */
function ommlParagraph(omml: string): string {
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><m:oMathPara>${omml}</m:oMathPara></w:p>`
}

/** 降级段落：居中显示 LaTeX 源码原文（可人工复制进公式编辑器） */
function sourceParagraph(tex: string): string {
  return (
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${escapeXml(tex)}</w:t></w:r></w:p>`
  )
}

/**
 * 找出包含占位文本的段落开始标签位置。
 *
 * 不能直接用 lastIndexOf('<w:p')：`<w:pPr>`、`<w:pStyle>` 等同样以 `<w:p` 开头。
 * 故向前回溯并校验标签名后紧跟 `>` 或空白。
 * @returns 段落开始标签的下标；找不到返回 -1
 */
function findParagraphStart(xml: string, before: number): number {
  let cursor = before
  while (cursor > 0) {
    const candidate = xml.lastIndexOf('<w:p', cursor)
    if (candidate < 0) return -1
    const next = xml[candidate + 4]
    if (next === '>' || next === ' ' || next === '\n' || next === '\t') return candidate
    cursor = candidate - 1
  }
  return -1
}

/**
 * 把包含占位文本的段落整段替换为给定段落 XML（导出供单测）。
 * @param xml - word/document.xml 内容
 * @param placeholder - 占位文本
 * @param replacement - 替换用的段落 XML（自带 <w:p>…</w:p>）
 * @returns 替换后的 XML；未找到占位时原样返回
 */
export function replacePlaceholderParagraph(
  xml: string,
  placeholder: string,
  replacement: string,
): string {
  const idx = xml.indexOf(placeholder)
  if (idx < 0) return xml
  const start = findParagraphStart(xml, idx)
  const end = xml.indexOf(PARA_CLOSE, idx)
  if (start < 0 || end < 0) return xml
  return xml.slice(0, start) + replacement + xml.slice(end + PARA_CLOSE.length)
}

/**
 * 后处理导出的 docx：把公式占位段落替换为 OMML，失败时降级为 LaTeX 源码文本。
 * @param docx - 导出的 .docx 字节
 * @param formulas - 独占公式的 LaTeX 源码列表（下标即占位序号）
 * @returns 处理后的字节；无公式、解压失败或未命中占位时原样返回
 */
export function injectOmmlFormulas(docx: Uint8Array, formulas: string[]): Uint8Array {
  if (!formulas.length) return docx
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(docx)
  } catch {
    return docx
  }
  const entry = files[DOCUMENT_PART]
  if (!entry) return docx

  let xml = strFromU8(entry)
  let replaced = 0
  let ommlInjected = 0
  for (let i = 0; i < formulas.length; i++) {
    const placeholder = mathPlaceholder(i)
    if (!xml.includes(placeholder)) continue
    const omml = latexToOmml(formulas[i])
    const next = replacePlaceholderParagraph(
      xml,
      placeholder,
      omml ? ommlParagraph(omml) : sourceParagraph(`$$${formulas[i]}$$`),
    )
    if (next === xml) continue
    xml = next
    replaced++
    if (omml) ommlInjected++
  }
  if (!replaced) return docx
  // 仅在真的注入了公式时补数学命名空间（生成器未必声明，已声明则不动）
  if (ommlInjected > 0 && !xml.includes('xmlns:m=')) {
    xml = xml.replace(/(<w:document\b[^>]*?)(\s*\/?>)/, `$1 xmlns:m="${MATH_NS}"$2`)
  }
  files[DOCUMENT_PART] = strToU8(xml)
  return zipSync(files)
}
