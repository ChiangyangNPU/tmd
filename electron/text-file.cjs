/**
 * 文本文件编码 / 换行检测与回写（纯 Node，不依赖 Electron，可独立单测）。
 *
 * 目标：打开 GBK / UTF-16 / 带 BOM 的文档时正确解码；保存时按原编码与原换行
 * 风格写回，避免「打开一次就把整个文件改成 UTF-8 + LF」的仓库级 diff。
 *
 * 检测顺序：
 * 1. BOM（UTF-8 / UTF-16LE / UTF-16BE）——最可靠
 * 2. 严格 UTF-8 校验——绝大多数 Markdown
 * 3. 无 BOM UTF-16 启发式（按零字节分布）
 * 4. GBK（中文用户最常见；GBK 解码几乎不会抛错，故放在 UTF-16 之后）
 * 5. 兜底 UTF-8 替换解码（不丢文件，只是替换非法字节）
 *
 * 换行：以 CRLF 与纯 LF 的数量多数决定保存风格；编辑器内部序列化统一为 LF，
 * 写盘前再按该风格转换。混合换行会被统一为多数风格（Markdown 文档可接受）。
 *
 * @author chiangyang
 */
const iconv = require('iconv-lite')

/** 支持的编码（IPC 入参白名单） */
const TEXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gbk']
/** 默认元信息：新文件 / 无法识别时的写回口径 */
const DEFAULT_TEXT_META = Object.freeze({ encoding: 'utf-8', bom: false, lineEnding: 'lf' })

/** @param {unknown} value @returns {value is typeof TEXT_ENCODINGS[number]} */
function isTextEncoding(value) {
  return typeof value === 'string' && TEXT_ENCODINGS.includes(value)
}

/** @param {unknown} value @returns {value is 'lf' | 'crlf'} */
function isLineEnding(value) {
  return value === 'lf' || value === 'crlf'
}

/**
 * 把外部传入的 meta 收窄为合法值（IPC 入参不可信）。
 * @param {unknown} meta
 * @returns {{ encoding: string, bom: boolean, lineEnding: 'lf' | 'crlf' }}
 */
function normalizeTextMeta(meta) {
  const m = /** @type {{ encoding?: unknown, bom?: unknown, lineEnding?: unknown } | null} */ (meta)
  const encoding = isTextEncoding(m?.encoding) ? m.encoding : DEFAULT_TEXT_META.encoding
  const lineEnding = isLineEnding(m?.lineEnding) ? m.lineEnding : DEFAULT_TEXT_META.lineEnding
  return {
    encoding,
    // GBK 无 BOM；其余编码按调用方给的值（默认不带）
    bom: encoding === 'gbk' ? false : Boolean(m?.bom),
    lineEnding,
  }
}

/**
 * 检测 BOM。返回去掉 BOM 后的正文 Buffer 与编码信息；无 BOM 返回 null。
 * @param {Buffer} buffer
 * @returns {{ encoding: 'utf-8' | 'utf-16le' | 'utf-16be', bom: true, body: Buffer } | null}
 */
function detectBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf-8', bom: true, body: buffer.subarray(3) }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf-16le', bom: true, body: buffer.subarray(2) }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf-16be', bom: true, body: buffer.subarray(2) }
  }
  return null
}

/**
 * 无 BOM UTF-16 启发式：ASCII / 中文在 UTF-16 下会有大量零字节集中在
 * 固定奇偶位。样本足够且一侧零字节占比超过阈值才判定，避免误伤 UTF-8/GBK。
 * @param {Buffer} buffer
 * @returns {'utf-16le' | 'utf-16be' | null}
 */
function detectUtf16WithoutBom(buffer) {
  if (buffer.length < 8) return null
  const pairs = Math.min(Math.floor(buffer.length / 2), 4096)
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = 0; i < pairs; i++) {
    if (buffer[i * 2] === 0) zeroEven++
    if (buffer[i * 2 + 1] === 0) zeroOdd++
  }
  const threshold = pairs * 0.3
  if (zeroOdd > threshold && zeroEven < pairs * 0.05) return 'utf-16le'
  if (zeroEven > threshold && zeroOdd < pairs * 0.05) return 'utf-16be'
  return null
}

/**
 * 统计换行风格：CRLF 数量多于纯 LF 时返回 crlf，否则 lf。
 * @param {string} text
 * @returns {'lf' | 'crlf'}
 */
function detectLineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const totalLf = (text.match(/\n/g) ?? []).length
  return crlf > totalLf - crlf ? 'crlf' : 'lf'
}

/**
 * 解码文本文件。
 * @param {Buffer | Uint8Array} input
 * @returns {{ content: string, encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk', bom: boolean, lineEnding: 'lf' | 'crlf' }}
 */
function decodeTextFile(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const bom = detectBom(buffer)
  if (bom) {
    const content = iconv.decode(bom.body, bom.encoding)
    return { content, encoding: bom.encoding, bom: true, lineEnding: detectLineEnding(content) }
  }

  // 严格 UTF-8：合法即 UTF-8（BOM 已在上面处理）
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { content, encoding: 'utf-8', bom: false, lineEnding: detectLineEnding(content) }
  } catch {
    /* 非 UTF-8，继续尝试 UTF-16 / GBK */
  }

  const utf16 = detectUtf16WithoutBom(buffer)
  if (utf16) {
    const content = iconv.decode(buffer, utf16)
    return { content, encoding: utf16, bom: false, lineEnding: detectLineEnding(content) }
  }

  // GBK 解码对大多数字节序列都能给出结果；作为非 UTF-8 的兜底，
  // 对中文用户比「按 UTF-8 替换」更接近原文
  try {
    const content = iconv.decode(buffer, 'gbk')
    return { content, encoding: 'gbk', bom: false, lineEnding: detectLineEnding(content) }
  } catch {
    const content = buffer.toString('utf8')
    return { content, encoding: 'utf-8', bom: false, lineEnding: detectLineEnding(content) }
  }
}

/**
 * 按检测到的编码与换行风格编码文本。
 * 编辑器内部统一使用 LF；写盘前按 lineEnding 转换。
 * @param {string} text
 * @param {unknown} meta
 * @returns {Buffer}
 */
function encodeTextFile(text, meta) {
  const normalized = normalizeTextMeta(meta)
  const lf = text.replace(/\r\n?/g, '\n')
  const withEol = normalized.lineEnding === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
  let body
  if (normalized.encoding === 'gbk') {
    body = iconv.encode(withEol, 'gbk')
  } else if (normalized.encoding === 'utf-16le') {
    body = iconv.encode(withEol, 'utf16-le')
  } else if (normalized.encoding === 'utf-16be') {
    body = iconv.encode(withEol, 'utf16-be')
  } else {
    body = Buffer.from(withEol, 'utf8')
  }
  if (!normalized.bom) return body
  if (normalized.encoding === 'utf-8') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
  }
  if (normalized.encoding === 'utf-16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), body])
  }
  if (normalized.encoding === 'utf-16be') {
    return Buffer.concat([Buffer.from([0xfe, 0xff]), body])
  }
  return body
}

module.exports = {
  TEXT_ENCODINGS,
  DEFAULT_TEXT_META,
  normalizeTextMeta,
  detectBom,
  detectUtf16WithoutBom,
  detectLineEnding,
  decodeTextFile,
  encodeTextFile,
}
