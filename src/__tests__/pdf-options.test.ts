import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { DEFAULT_PDF_OPTIONS, normalizePdfOptions, parsePdfOptions } from '../pdf-options'

const require = createRequire(import.meta.url)
const pdf = require('../../electron/pdf-options.cjs') as {
  DEFAULT_PDF_OPTIONS: typeof DEFAULT_PDF_OPTIONS
  normalizePdfOptions: (value: unknown) => typeof DEFAULT_PDF_OPTIONS
  buildPrintToPdfOptions: (
    value: unknown,
    name: unknown,
  ) => {
    pageSize: string
    landscape: boolean
    printBackground: boolean
    preferCSSPageSize: boolean
    margins: { top: number; bottom: number; left: number; right: number }
    displayHeaderFooter: boolean
    headerTemplate: string
    footerTemplate: string
    generateDocumentOutline: boolean
  }
}

describe('PDF 导出选项', () => {
  it('渲染层默认值/收窄/损坏 JSON 回落一致', () => {
    expect(normalizePdfOptions(null)).toEqual(DEFAULT_PDF_OPTIONS)
    expect(
      normalizePdfOptions({
        pageSize: 'B5',
        orientation: 'diagonal',
        margin: 'huge',
        headerFooter: 1,
        pageNumbers: 'yes',
        outline: false,
      }),
    ).toEqual({
      ...DEFAULT_PDF_OPTIONS,
      headerFooter: true,
      pageNumbers: true,
      outline: false,
    })
    expect(parsePdfOptions('{broken')).toEqual(DEFAULT_PDF_OPTIONS)
    expect(parsePdfOptions(JSON.stringify({ pageSize: 'Letter' }))).toEqual({
      ...DEFAULT_PDF_OPTIONS,
      pageSize: 'Letter',
    })
  })

  it('主进程生成 printToPDF 参数：默认 A4/18mm/无页眉页脚/带书签', () => {
    const out = pdf.buildPrintToPdfOptions(null, '笔记.md')
    expect(out.pageSize).toBe('A4')
    expect(out.landscape).toBe(false)
    expect(out.printBackground).toBe(true)
    expect(out.preferCSSPageSize).toBe(false)
    expect(out.generateDocumentOutline).toBe(true)
    expect(out.displayHeaderFooter).toBe(false)
    expect(out.margins.left).toBeCloseTo(18 / 25.4, 4)
    expect(out.headerTemplate).toBe('<span></span>')
    expect(out.footerTemplate).toBe('<span></span>')
  })

  it('页眉页脚/页码/横向/纸张/边距生效，标题做 HTML 转义', () => {
    const out = pdf.buildPrintToPdfOptions(
      {
        pageSize: 'Letter',
        orientation: 'landscape',
        margin: 'wide',
        headerFooter: true,
        pageNumbers: true,
        outline: false,
      },
      '<b>x</b>.md',
    )
    expect(out.pageSize).toBe('Letter')
    expect(out.landscape).toBe(true)
    expect(out.margins.top).toBeCloseTo(25 / 25.4, 4)
    expect(out.displayHeaderFooter).toBe(true)
    expect(out.headerTemplate).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(out.headerTemplate).not.toContain('<b>x</b>')
    expect(out.footerTemplate).toContain('class="pageNumber"')
    expect(out.footerTemplate).toContain('class="totalPages"')
    expect(out.generateDocumentOutline).toBe(false)
  })

  it('非法枚举回落默认，避免渲染层传任意值到 Electron', () => {
    expect(pdf.normalizePdfOptions({ pageSize: 'X', orientation: 'X', margin: 'X' })).toEqual({
      ...pdf.DEFAULT_PDF_OPTIONS,
      headerFooter: false,
      pageNumbers: false,
    })
    expect(pdf.buildPrintToPdfOptions({ pageSize: 'X' }, 'a.md').pageSize).toBe('A4')
  })
})
