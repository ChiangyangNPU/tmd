import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  injectOmmlFormulas,
  latexToOmml,
  mathPlaceholder,
  replacePlaceholderParagraph,
} from '../export-omml'

/** 造一个只含 word/document.xml 的最小 docx（zip） */
function makeDocx(documentXml: string): Uint8Array {
  return zipSync({ 'word/document.xml': strToU8(documentXml) })
}

/** 读回处理后的 document.xml */
function readDocumentXml(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)['word/document.xml'])
}

/** 最小 document.xml（不含 m 命名空间声明，用于验证补声明） */
const docXml = (body: string) =>
  '<?xml version="1.0"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  `<w:body>${body}</w:body></w:document>`

describe('latexToOmml', () => {
  it('分数转出 OMML 分数结构', () => {
    const omml = latexToOmml('\\frac{a}{b}')
    expect(omml).toContain('<m:oMath')
    expect(omml).toContain('<m:f>')
  })

  it('上标转出 OMML 上标结构', () => {
    expect(latexToOmml('x^{2}')).toContain('<m:sSup>')
  })

  it('求和与积分等大运算符可转换', () => {
    expect(latexToOmml('\\sum_{i=1}^{n} x_i')).toContain('<m:oMath')
    expect(latexToOmml('\\int_0^1 x^2\\,dx')).toContain('<m:oMath')
  })

  it('空源码与非法表达式返回 null（交调用方降级）', () => {
    expect(latexToOmml('')).toBeNull()
    expect(latexToOmml('   ')).toBeNull()
    expect(latexToOmml('\\frac{a')).toBeNull()
  })
})

describe('replacePlaceholderParagraph', () => {
  it('整段替换占位段落，且不把 <w:pPr 误认成段落起点', () => {
    const xml =
      '<w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
      `<w:r><w:t>${mathPlaceholder(0)}</w:t></w:r></w:p></w:body>`
    const out = replacePlaceholderParagraph(xml, mathPlaceholder(0), '<w:p>REPLACED</w:p>')
    expect(out).toBe('<w:body><w:p>REPLACED</w:p></w:body>')
  })

  it('未找到占位时原样返回', () => {
    const xml = '<w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body>'
    expect(replacePlaceholderParagraph(xml, mathPlaceholder(9), '<w:p>R</w:p>')).toBe(xml)
  })
})

describe('injectOmmlFormulas', () => {
  const placeholderPara = (i: number) => `<w:p><w:r><w:t>${mathPlaceholder(i)}</w:t></w:r></w:p>`

  it('把占位段落替换为 OMML，并补声明数学命名空间', () => {
    const bytes = makeDocx(docXml(placeholderPara(0)))
    const out = readDocumentXml(injectOmmlFormulas(bytes, ['\\frac{a}{b}']))
    expect(out).toContain('<m:oMath')
    expect(out).toContain('<w:jc w:val="center"/>')
    expect(out).toContain('xmlns:m=')
    expect(out).not.toContain(mathPlaceholder(0))
  })

  it('转换失败时降级为 LaTeX 源码文本', () => {
    const bytes = makeDocx(docXml(placeholderPara(0)))
    const out = readDocumentXml(injectOmmlFormulas(bytes, ['\\frac{a']))
    expect(out).not.toContain(mathPlaceholder(0))
    // 源码原样落为文本，两侧补 $ 定界符（便于复制进 Word 公式区）
    expect(out).toContain('$$\\frac{a$$')
    expect(out).not.toContain('<m:oMath')
    // 没有注入公式就不该补数学命名空间
    expect(out).not.toContain('xmlns:m=')
  })

  it('多个公式按序各自替换', () => {
    const bytes = makeDocx(docXml(placeholderPara(0) + placeholderPara(1)))
    const out = readDocumentXml(injectOmmlFormulas(bytes, ['x^{2}', 'y_{1}']))
    expect(out).not.toContain(mathPlaceholder(0))
    expect(out).not.toContain(mathPlaceholder(1))
    expect((out.match(/<m:oMath/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('无公式或未命中占位时原样返回同一字节', () => {
    const bytes = makeDocx(docXml('<w:p><w:r><w:t>x</w:t></w:r></w:p>'))
    expect(injectOmmlFormulas(bytes, [])).toBe(bytes)
    expect(injectOmmlFormulas(bytes, ['x^2'])).toBe(bytes)
  })

  it('非 zip 字节（解压失败）时原样返回', () => {
    const junk = strToU8('not a zip archive')
    expect(injectOmmlFormulas(junk, ['x^2'])).toBe(junk)
  })
})
