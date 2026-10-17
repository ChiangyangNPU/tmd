/**
 * PDF 导出选项：设置面板持久化与导出时传给主进程的纯数据。
 *
 * 主进程侧有一份同构的 electron/pdf-options.cjs（负责最终校验 + 转成
 * Electron printToPDF 参数）；这里只做渲染层默认值与读存储时的收窄，
 * 两边枚举保持一致。
 */

export type PdfPageSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal'
export type PdfOrientation = 'portrait' | 'landscape'
export type PdfMargin = 'default' | 'narrow' | 'wide'

export interface PdfOptions {
  pageSize: PdfPageSize
  orientation: PdfOrientation
  /** default=18mm / narrow=10mm / wide=25mm */
  margin: PdfMargin
  /** 页眉（标题 + 日期） */
  headerFooter: boolean
  /** 页脚页码 */
  pageNumbers: boolean
  /** 从标题生成 PDF 书签 */
  outline: boolean
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  pageSize: 'A4',
  orientation: 'portrait',
  margin: 'default',
  headerFooter: false,
  pageNumbers: false,
  outline: true,
}

const PAGE_SIZES: PdfPageSize[] = ['A4', 'A3', 'A5', 'Letter', 'Legal']
const ORIENTATIONS: PdfOrientation[] = ['portrait', 'landscape']
const MARGINS: PdfMargin[] = ['default', 'narrow', 'wide']

/** 收窄任意输入（存储 JSON / 旧版本数据）为合法选项 */
export function normalizePdfOptions(value: unknown): PdfOptions {
  const v = value as Partial<PdfOptions> | null | undefined
  return {
    pageSize: PAGE_SIZES.includes(v?.pageSize as PdfPageSize)
      ? (v?.pageSize as PdfPageSize)
      : DEFAULT_PDF_OPTIONS.pageSize,
    orientation: ORIENTATIONS.includes(v?.orientation as PdfOrientation)
      ? (v?.orientation as PdfOrientation)
      : DEFAULT_PDF_OPTIONS.orientation,
    margin: MARGINS.includes(v?.margin as PdfMargin)
      ? (v?.margin as PdfMargin)
      : DEFAULT_PDF_OPTIONS.margin,
    headerFooter: Boolean(v?.headerFooter),
    pageNumbers: Boolean(v?.pageNumbers),
    outline: v?.outline === undefined ? DEFAULT_PDF_OPTIONS.outline : Boolean(v.outline),
  }
}

/** 解析 localStorage 中的 JSON；损坏/缺失回落默认值 */
export function parsePdfOptions(raw: string | null): PdfOptions {
  if (!raw) return { ...DEFAULT_PDF_OPTIONS }
  try {
    return normalizePdfOptions(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_PDF_OPTIONS }
  }
}
