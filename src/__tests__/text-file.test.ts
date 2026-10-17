import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const iconv = require('iconv-lite') as {
  encode: (text: string, encoding: string) => Buffer
  decode: (buffer: Buffer, encoding: string) => string
}
const textFile = require('../../electron/text-file.cjs') as {
  TEXT_ENCODINGS: string[]
  DEFAULT_TEXT_META: { encoding: string; bom: boolean; lineEnding: 'lf' | 'crlf' }
  normalizeTextMeta: (meta: unknown) => {
    encoding: string
    bom: boolean
    lineEnding: 'lf' | 'crlf'
  }
  detectLineEnding: (text: string) => 'lf' | 'crlf'
  decodeTextFile: (input: Buffer | Uint8Array) => {
    content: string
    encoding: string
    bom: boolean
    lineEnding: 'lf' | 'crlf'
  }
  encodeTextFile: (text: string, meta: unknown) => Buffer
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])

describe('decodeTextFile / encodeTextFile', () => {
  it('UTF-8：LF 与 BOM 都能识别并字节级回写', () => {
    const plain = Buffer.from('中文\nline2\n', 'utf8')
    expect(textFile.decodeTextFile(plain)).toEqual({
      content: '中文\nline2\n',
      encoding: 'utf-8',
      bom: false,
      lineEnding: 'lf',
    })
    expect(textFile.encodeTextFile('中文\nline2\n', { encoding: 'utf-8', lineEnding: 'lf' })).toEqual(
      plain,
    )

    const withBom = Buffer.concat([utf8Bom, plain])
    const decoded = textFile.decodeTextFile(withBom)
    expect(decoded).toMatchObject({ content: '中文\nline2\n', encoding: 'utf-8', bom: true })
    expect(textFile.encodeTextFile(decoded.content, decoded)).toEqual(withBom)
  })

  it('UTF-16LE / UTF-16BE（带 BOM 与无 BOM）解码与回写', () => {
    for (const encoding of ['utf-16le', 'utf-16be'] as const) {
      const iconvName = encoding === 'utf-16le' ? 'utf16-le' : 'utf16-be'
      const body = iconv.encode('中文\r\nline', iconvName)
      const decoded = textFile.decodeTextFile(body)
      expect(decoded).toEqual({
        content: '中文\r\nline',
        encoding,
        bom: false,
        lineEnding: 'crlf',
      })
      expect(textFile.encodeTextFile(decoded.content, decoded)).toEqual(body)

      const bom = encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]
      const withBom = Buffer.concat([Buffer.from(bom), body])
      const decodedBom = textFile.decodeTextFile(withBom)
      expect(decodedBom).toMatchObject({ content: '中文\r\nline', encoding, bom: true })
      expect(textFile.encodeTextFile(decodedBom.content, decodedBom)).toEqual(withBom)
    }
  })

  it('GBK 解码并原样回写', () => {
    const body = iconv.encode('中文\r\nline', 'gbk')
    const decoded = textFile.decodeTextFile(body)
    expect(decoded).toEqual({
      content: '中文\r\nline',
      encoding: 'gbk',
      bom: false,
      lineEnding: 'crlf',
    })
    expect(textFile.encodeTextFile(decoded.content, decoded)).toEqual(body)
  })

  it('CRLF 保存：编辑器 LF 内容按原风格转换；LF 文件保持 LF', () => {
    expect(textFile.encodeTextFile('a\nb\n', { encoding: 'utf-8', lineEnding: 'crlf' })).toEqual(
      Buffer.from('a\r\nb\r\n', 'utf8'),
    )
    expect(textFile.encodeTextFile('a\r\nb\n', { encoding: 'utf-8', lineEnding: 'lf' })).toEqual(
      Buffer.from('a\nb\n', 'utf8'),
    )
  })

  it('非法 UTF-8 字节回落 GBK；无法识别时至少不抛错', () => {
    const decoded = textFile.decodeTextFile(iconv.encode('中文', 'gbk'))
    expect(decoded.encoding).toBe('gbk')
    expect(decoded.content).toBe('中文')
    // 空文件 / 任意字节都不应抛错
    expect(textFile.decodeTextFile(Buffer.from([]))).toMatchObject({ content: '', encoding: 'utf-8' })
    expect(() => textFile.decodeTextFile(Buffer.from([0x00, 0x80, 0xff]))).not.toThrow()
  })

  it('textMeta 入参白名单：非法编码/换行回落默认，GBK 强制无 BOM', () => {
    expect(textFile.normalizeTextMeta(null)).toEqual(textFile.DEFAULT_TEXT_META)
    expect(textFile.normalizeTextMeta({ encoding: 'utf-32', lineEnding: 'cr' })).toEqual(
      textFile.DEFAULT_TEXT_META,
    )
    expect(textFile.normalizeTextMeta({ encoding: 'gbk', bom: true, lineEnding: 'crlf' })).toEqual({
      encoding: 'gbk',
      bom: false,
      lineEnding: 'crlf',
    })
    expect(textFile.TEXT_ENCODINGS).toEqual(['utf-8', 'utf-16le', 'utf-16be', 'gbk'])
  })

  it('detectLineEnding：CRLF 占多数返回 crlf，无换行默认 lf', () => {
    expect(textFile.detectLineEnding('a\r\nb\r\nc\n')).toBe('crlf')
    expect(textFile.detectLineEnding('a\nb\nc\r\n')).toBe('lf')
    expect(textFile.detectLineEnding('单行')).toBe('lf')
  })
})
