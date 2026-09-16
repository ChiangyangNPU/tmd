import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// exporter.cjs 是纯 Node 模块（Electron 能力由 main.cjs 注入），可直接 require 断言
const require = createRequire(import.meta.url)
const exporter = require('../../electron/exporter.cjs') as {
  fileUrlToPath(fileUrl: unknown): string | null
  imageMimeOf(filePath: string): string | null
  readImageAsDataUri(fileUrl: unknown): Promise<string | null>
}

describe('fileUrlToPath 本地图片地址解析', () => {
  it('POSIX 绝对路径保持不变', () => {
    expect(exporter.fileUrlToPath('file:///Users/x/a.png')).toBe('/Users/x/a.png')
  })

  it('Windows 盘符路径去掉多余前导斜杠', () => {
    expect(exporter.fileUrlToPath('file:///E:/docs/a.png')).toBe('E:/docs/a.png')
  })

  it('百分号转义被还原（含中文与空格、%23 转义的 #）', () => {
    expect(exporter.fileUrlToPath('file:///docs/%E4%B8%AD%E6%96%87.png')).toBe('/docs/中文.png')
    expect(exporter.fileUrlToPath('file:///docs/a%20b.png')).toBe('/docs/a b.png')
    expect(exporter.fileUrlToPath('file:///docs/a%23b.png')).toBe('/docs/a#b.png')
  })

  it('非 file: 协议、相对路径、非法转义一律拒绝', () => {
    expect(exporter.fileUrlToPath('https://x.com/a.png')).toBeNull()
    expect(exporter.fileUrlToPath('file://relative/a.png')).toBeNull()
    expect(exporter.fileUrlToPath('file:///docs/%ZZ.png')).toBeNull()
    expect(exporter.fileUrlToPath('')).toBeNull()
    expect(exporter.fileUrlToPath(undefined)).toBeNull()
    expect(exporter.fileUrlToPath(123)).toBeNull()
  })
})

describe('imageMimeOf 图片类型白名单', () => {
  it('收录常见位图格式（大小写不敏感）', () => {
    expect(exporter.imageMimeOf('/a/b.png')).toBe('image/png')
    expect(exporter.imageMimeOf('/a/b.JPG')).toBe('image/jpeg')
    expect(exporter.imageMimeOf('/a/b.jpeg')).toBe('image/jpeg')
    expect(exporter.imageMimeOf('/a/b.webp')).toBe('image/webp')
    expect(exporter.imageMimeOf('/a/b.svg')).toBe('image/svg+xml')
  })

  it('非图片扩展名拒绝', () => {
    expect(exporter.imageMimeOf('/a/b.txt')).toBeNull()
    expect(exporter.imageMimeOf('/a/b')).toBeNull()
    expect(exporter.imageMimeOf('/a/b.md')).toBeNull()
  })
})

describe('readImageAsDataUri 本地图片读盘', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmd-exporter-'))
    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    await writeFile(join(dir, 'tiny.png'), png)
    await writeFile(join(dir, 'note.txt'), 'not an image')
    await writeFile(join(dir, '中文 名.png'), png)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('按 MIME 生成 data URI', async () => {
    const uri = await exporter.readImageAsDataUri(`file://${dir}/tiny.png`)
    expect(uri).toMatch(/^data:image\/png;base64,/)
    expect(uri?.length).toBeGreaterThan(60)
  })

  it('含中文与空格的文件名可读（URL 转义往返）', async () => {
    const uri = await exporter.readImageAsDataUri(`file://${encodeURI(`${dir}/中文 名.png`)}`)
    expect(uri).toMatch(/^data:image\/png;base64,/)
  })

  it('非图片扩展名、文件不存在、非法地址一律返回 null', async () => {
    expect(await exporter.readImageAsDataUri(`file://${dir}/note.txt`)).toBeNull()
    expect(await exporter.readImageAsDataUri(`file://${dir}/missing.png`)).toBeNull()
    expect(await exporter.readImageAsDataUri('https://x.com/a.png')).toBeNull()
    expect(await exporter.readImageAsDataUri(null)).toBeNull()
  })
})
