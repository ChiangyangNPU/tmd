import { describe, it, expect } from 'vitest'
import { isWindowsPath, normalizeFsPath, dirOf, isSameFsPath } from '../fs-path'

describe('normalizeFsPath', () => {
  it('统一反斜杠为正斜杠', () => {
    expect(normalizeFsPath('E:\\docs\\a.md')).toBe('E:/docs/a.md')
  })

  it('保留盘符前缀（不补前导斜杠）', () => {
    expect(normalizeFsPath('E:\\a\\b')).toBe('E:/a/b')
    expect(normalizeFsPath('e:/a/b')).toBe('e:/a/b')
  })

  it('POSIX 路径保持以 / 开头', () => {
    expect(normalizeFsPath('/Users/me/docs/a.md')).toBe('/Users/me/docs/a.md')
  })

  it('折叠 . 与 .. 段', () => {
    expect(normalizeFsPath('E:\\docs\\notes\\..\\a.md')).toBe('E:/docs/a.md')
    expect(normalizeFsPath('/a/b/../c.md')).toBe('/a/c.md')
  })

  it('折叠重复分隔符与空段', () => {
    expect(normalizeFsPath('E:\\\\a//b')).toBe('E:/a/b')
    expect(normalizeFsPath('/a//b/')).toBe('/a/b')
  })

  it('相对路径不加前导斜杠', () => {
    expect(normalizeFsPath('docs\\a.md')).toBe('docs/a.md')
  })

  it('对已规范化的路径幂等', () => {
    const once = normalizeFsPath('E:\\a\\..\\b\\c.md')
    expect(normalizeFsPath(once)).toBe(once)
  })
})

describe('isWindowsPath', () => {
  it('盘符、UNC 与反斜杠均判为 Windows 风格', () => {
    expect(isWindowsPath('E:\\a')).toBe(true)
    expect(isWindowsPath('E:/a')).toBe(true)
    expect(isWindowsPath('\\\\server\\share')).toBe(true)
  })

  it('POSIX 路径判为非 Windows', () => {
    expect(isWindowsPath('/Users/me')).toBe(false)
    expect(isWindowsPath('docs/a.md')).toBe(false)
  })
})

describe('dirOf', () => {
  it('兼容正反斜杠两种分隔符', () => {
    expect(dirOf('/a/b/c.md')).toBe('/a/b')
    expect(dirOf('E:\\a\\b\\c.md')).toBe('E:\\a\\b')
    expect(dirOf('E:/a/b/c.md')).toBe('E:/a/b')
  })

  it('无分隔符返回空串', () => {
    expect(dirOf('c.md')).toBe('')
  })
})

describe('isSameFsPath', () => {
  it('忽略分隔符差异', () => {
    expect(isSameFsPath('E:\\docs\\a.md', 'E:/docs/a.md')).toBe(true)
  })

  it('Windows 路径忽略大小写', () => {
    expect(isSameFsPath('E:\\Docs\\A.md', 'e:/docs/a.md')).toBe(true)
  })

  it('POSIX 路径区分大小写', () => {
    expect(isSameFsPath('/Docs/A.md', '/docs/a.md')).toBe(false)
  })

  it('不同路径判为不同', () => {
    expect(isSameFsPath('/a/b.md', '/a/c.md')).toBe(false)
  })
})
