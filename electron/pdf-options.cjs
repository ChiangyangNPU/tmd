/**
 * PDF 导出选项 → Electron printToPDF 参数（纯 Node，可独立单测）。
 *
 * 渲染层只传用户选择的枚举值；主进程在此做最终白名单校验，并生成页眉/页脚
 * 模板与英寸边距。与 src/pdf-options.ts 的枚举、默认值保持一致。
 *
 * @author chiangyang
 */

/**
 * @typedef {'A4' | 'A3' | 'A5' | 'Letter' | 'Legal'} PdfPageSize
 * @typedef {'portrait' | 'landscape'} PdfOrientation
 * @typedef {'default' | 'narrow' | 'wide'} PdfMargin
 * @typedef {{
 *   pageSize: PdfPageSize,
 *   orientation: PdfOrientation,
 *   margin: PdfMargin,
 *   headerFooter: boolean,
 *   pageNumbers: boolean,
 *   outline: boolean,
 * }} PdfOptions
 */

/** @type {PdfPageSize[]} */
const PDF_PAGE_SIZES = ['A4', 'A3', 'A5', 'Letter', 'Legal']
/** @type {PdfOrientation[]} */
const PDF_ORIENTATIONS = ['portrait', 'landscape']
/** @type {PdfMargin[]} */
const PDF_MARGINS = ['default', 'narrow', 'wide']
/** @type {Record<PdfMargin, number>} */
const MARGIN_MM = { default: 18, narrow: 10, wide: 25 }
/** @type {PdfOptions} */
const DEFAULT_PDF_OPTIONS = Object.freeze({
  pageSize: 'A4',
  orientation: 'portrait',
  margin: 'default',
  headerFooter: false,
  pageNumbers: false,
  outline: true,
})

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/**
 * 收窄 IPC 入参 → 合法 PDF 选项。
 * @param {unknown} value
 * @returns {PdfOptions}
 */
function normalizePdfOptions(value) {
  const v = /** @type {Record<string, unknown> | null | undefined} */ (value)
  const pageSize = typeof v?.pageSize === 'string' ? v.pageSize : ''
  const orientation = typeof v?.orientation === 'string' ? v.orientation : ''
  const margin = typeof v?.margin === 'string' ? v.margin : ''
  return {
    pageSize: /** @type {PdfPageSize} */ (
      PDF_PAGE_SIZES.includes(/** @type {PdfPageSize} */ (pageSize))
        ? pageSize
        : DEFAULT_PDF_OPTIONS.pageSize
    ),
    orientation: /** @type {PdfOrientation} */ (
      PDF_ORIENTATIONS.includes(/** @type {PdfOrientation} */ (orientation))
        ? orientation
        : DEFAULT_PDF_OPTIONS.orientation
    ),
    margin: /** @type {PdfMargin} */ (
      PDF_MARGINS.includes(/** @type {PdfMargin} */ (margin)) ? margin : DEFAULT_PDF_OPTIONS.margin
    ),
    headerFooter: Boolean(v?.headerFooter),
    pageNumbers: Boolean(v?.pageNumbers),
    outline: v?.outline === undefined ? DEFAULT_PDF_OPTIONS.outline : Boolean(v.outline),
  }
}

/**
 * 构造 webContents.printToPDF 参数。
 * @param {unknown} raw 渲染层选项（不可信）
 * @param {unknown} name 文档名（用于页眉标题；可带 .md 扩展名）
 * @returns {import('electron').PrintToPDFOptions}
 */
function buildPrintToPdfOptions(raw, name) {
  const options = normalizePdfOptions(raw)
  const marginIn = MARGIN_MM[options.margin] / 25.4
  const showHeaderFooter = options.headerFooter || options.pageNumbers
  const title = String(name ?? '')
    .replace(/\.(md|markdown|txt)$/i, '')
    .trim()
  const headerTemplate = options.headerFooter
    ? `<div style="font-size:8px;width:100%;padding:0 10mm;color:#666;display:flex;justify-content:space-between;"><span>${escapeHtml(title || 'TMD')}</span><span class="date"></span></div>`
    : '<span></span>'
  const footerTemplate = options.pageNumbers
    ? '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    : '<span></span>'
  return {
    pageSize: options.pageSize,
    landscape: options.orientation === 'landscape',
    printBackground: true,
    preferCSSPageSize: false,
    margins: { top: marginIn, bottom: marginIn, left: marginIn, right: marginIn },
    displayHeaderFooter: showHeaderFooter,
    headerTemplate,
    footerTemplate,
    generateDocumentOutline: options.outline,
  }
}

module.exports = {
  PDF_PAGE_SIZES,
  PDF_ORIENTATIONS,
  PDF_MARGINS,
  MARGIN_MM,
  DEFAULT_PDF_OPTIONS,
  normalizePdfOptions,
  buildPrintToPdfOptions,
}
