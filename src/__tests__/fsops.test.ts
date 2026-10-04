import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'

// electron/fsops.cjs 是纯 Node CJS 模块：文件管理的名称清洗与路径拼装
const require = createRequire(import.meta.url)
const fsops = require('../../electron/fsops.cjs') as {
  sanitizeFileName: (name: unknown) => string | null
  childPath: (dir: unknown, name: unknown) => string | null
  ensureMarkdownExt: (name: string) => string
  MAX_NAME_LENGTH: number
}

describe('sanitizeFileName', () => {
  it('合法名称原样返回（含中文与空格）', () => {
    expect(fsops.sanitizeFileName('会议记录')).toBe('会议记录')
    expect(fsops.sanitizeFileName('  meeting notes  ')).toBe('meeting notes')
  })

  it('拒绝空串、非字符串与纯点', () => {
    expect(fsops.sanitizeFileName('')).toBeNull()
    expect(fsops.sanitizeFileName('   ')).toBeNull()
    expect(fsops.sanitizeFileName(null)).toBeNull()
    expect(fsops.sanitizeFileName(42)).toBeNull()
    expect(fsops.sanitizeFileName('.')).toBeNull()
    expect(fsops.sanitizeFileName('..')).toBeNull()
  })

  it('拒绝路径分隔符与目录穿越片段', () => {
    expect(fsops.sanitizeFileName('a/b')).toBeNull()
    expect(fsops.sanitizeFileName('a\\b')).toBeNull()
    expect(fsops.sanitizeFileName('../secret.md')).toBeNull()
  })

  it('拒绝隐藏文件（点开头）与控制字符', () => {
    expect(fsops.sanitizeFileName('.DS_Store')).toBeNull()
    expect(fsops.sanitizeFileName('.hidden')).toBeNull()
    expect(fsops.sanitizeFileName('a\u0000b')).toBeNull()
    expect(fsops.sanitizeFileName('a\nb')).toBeNull()
  })

  it('拒绝超长名称', () => {
    expect(fsops.sanitizeFileName('a'.repeat(fsops.MAX_NAME_LENGTH + 1))).toBeNull()
    expect(fsops.sanitizeFileName('a'.repeat(fsops.MAX_NAME_LENGTH))).toBe('a'.repeat(fsops.MAX_NAME_LENGTH))
  })
})

describe('childPath', () => {
  const dir = path.join('/tmp', 'ws')

  it('拼装目录与已清洗名称', () => {
    expect(fsops.childPath(dir, '笔记.md')).toBe(path.join(dir, '笔记.md'))
  })

  it('非法输入返回 null：非法目录 / 非法名称 / 越出目录的构造', () => {
    expect(fsops.childPath('', 'a.md')).toBeNull()
    expect(fsops.childPath(dir, '../x.md')).toBeNull()
    expect(fsops.childPath(dir, 'a/b.md')).toBeNull()
    expect(fsops.childPath(null, 'a.md')).toBeNull()
  })
})

describe('ensureMarkdownExt', () => {
  it('无扩展名补 .md；已有（大小写不敏感）原样保留', () => {
    expect(fsops.ensureMarkdownExt('笔记')).toBe('笔记.md')
    expect(fsops.ensureMarkdownExt('a.md')).toBe('a.md')
    expect(fsops.ensureMarkdownExt('a.MD')).toBe('a.MD')
  })
})
