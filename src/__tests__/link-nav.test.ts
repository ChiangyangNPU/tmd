import { describe, it, expect } from 'vitest'
import { resolveLink, normalizePath } from '../link-nav'

describe('normalizePath', () => {
  it('解析 ./ 与 ../ 段', () => {
    expect(normalizePath('/docs/notes/./a.md')).toBe('/docs/notes/a.md')
    expect(normalizePath('/docs/notes/../images/a.png')).toBe('/docs/images/a.png')
    expect(normalizePath('/a/b/../../c.md')).toBe('/c.md')
  })

  it('吞掉空段与多余斜杠', () => {
    expect(normalizePath('/a//b/')).toBe('/a/b')
  })
})

describe('resolveLink', () => {
  const base = '/Users/me/docs'

  it('http/https → external', () => {
    expect(resolveLink('https://example.com/a', null)).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    })
    expect(resolveLink('HTTP://EXAMPLE.COM', base)?.kind).toBe('external')
  })

  it('mailto/tel/锚点不处理', () => {
    expect(resolveLink('mailto:a@b.com', base)).toBeNull()
    expect(resolveLink('tel:123', base)).toBeNull()
    expect(resolveLink('#section', base)).toBeNull()
  })

  it('绝对路径与 file:// → file', () => {
    expect(resolveLink('/Users/me/a.md', null)).toEqual({ kind: 'file', path: '/Users/me/a.md' })
    expect(resolveLink('file:///Users/me/a%20b.md', null)).toEqual({
      kind: 'file',
      path: '/Users/me/a b.md',
    })
  })

  it('相对路径按 baseDir 解析（含 ../）', () => {
    expect(resolveLink('./notes/a.md', base)).toEqual({
      kind: 'file',
      path: '/Users/me/docs/notes/a.md',
    })
    expect(resolveLink('../images/a.png', `${base}/notes`)).toEqual({
      kind: 'file',
      path: '/Users/me/docs/images/a.png',
    })
  })

  it('相对路径无 baseDir（文档未保存）返回 null', () => {
    expect(resolveLink('a.md', null)).toBeNull()
  })

  it('空 href 返回 null', () => {
    expect(resolveLink('  ', base)).toBeNull()
  })
})

describe('resolveLink file:// UNC', () => {
  it('file://host/share 保留 UNC 形态，不当作相对路径拼进 baseDir', () => {
    const t = resolveLink('file://server/share/a.md', '/home/user/docs')
    expect(t).toEqual({ kind: 'file', path: '//server/share/a.md' })
  })

  it('file:///path（三斜杠本机路径）行为不变', () => {
    expect(resolveLink('file:///Users/a/b.md', '/tmp')).toEqual({
      kind: 'file',
      path: '/Users/a/b.md',
    })
  })
})
