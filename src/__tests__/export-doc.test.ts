import { describe, expect, it } from 'vitest'
import { resolveExportImageRef } from '../export-doc'

describe('resolveExportImageRef 导出图片引用分类', () => {
  it('data: URI 视为已内嵌', () => {
    const r = resolveExportImageRef('data:image/png;base64,AAAA', '/doc')
    expect(r).toEqual({ kind: 'embedded' })
  })

  it('http/https 视为远程图片，原样保留', () => {
    expect(resolveExportImageRef('https://x.com/a.png', null)).toEqual({
      kind: 'remote',
      src: 'https://x.com/a.png',
    })
    expect(resolveExportImageRef('http://x.com/a.png', '/doc')).toEqual({
      kind: 'remote',
      src: 'http://x.com/a.png',
    })
  })

  it('已有 file: URL 标记为本地，交给主进程读盘', () => {
    expect(resolveExportImageRef('file:///Users/x/a.png', null)).toEqual({
      kind: 'local',
      fileUrl: 'file:///Users/x/a.png',
    })
  })

  it('相对路径 + 文档目录解析为 file:// 本地引用', () => {
    const r = resolveExportImageRef('assets/a b.png', '/Users/x/docs')
    expect(r).toEqual({
      kind: 'local',
      fileUrl: 'file:///Users/x/docs/assets/a%20b.png',
    })
  })

  it('Windows 反斜杠相对路径同样可解析', () => {
    const r = resolveExportImageRef('assets\\a.png', 'E:/docs')
    expect(r).toEqual({ kind: 'local', fileUrl: 'file:///E:/docs/assets/a.png' })
  })

  it('相对路径但文档未保存（无目录）→ blocked', () => {
    expect(resolveExportImageRef('assets/a.png', null)).toEqual({ kind: 'blocked' })
  })

  it('危险协议 javascript:/vbscript: 阻断', () => {
    expect(resolveExportImageRef('javascript:alert(1)', '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef('vbscript:msgbox(1)', '/doc')).toEqual({ kind: 'blocked' })
  })

  it('blob: 跨页失效，阻断；根相对与协议相对路径阻断', () => {
    expect(resolveExportImageRef('blob:http://x/abc', '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef('/etc/passwd', '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef('//evil.com/a.png', '/doc')).toEqual({ kind: 'blocked' })
  })

  it('空串与非字符串阻断；前后空白被裁剪', () => {
    expect(resolveExportImageRef('', '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef('   ', '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef(undefined, '/doc')).toEqual({ kind: 'blocked' })
    expect(resolveExportImageRef('  https://x.com/a.png  ', null)).toEqual({
      kind: 'remote',
      src: 'https://x.com/a.png',
    })
  })

  it('文件名含 # 时转义为 %23，避免被截断', () => {
    const r = resolveExportImageRef('assets/a#b.png', '/docs')
    expect(r).toEqual({ kind: 'local', fileUrl: 'file:///docs/assets/a%23b.png' })
  })
})
