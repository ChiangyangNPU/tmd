/**
 * 改名引用重写（src/link-rewrite.ts）单元测试：
 * - rewriteContent 的替换规则（别名/标题锚保留、.md 书写习惯保留、
 *   子目录前缀改写相对路径、围栏块跳过、非候选不动）
 */
import { describe, expect, test } from 'vitest'
import { rewriteContent } from '../link-rewrite'
import type { WikiLinkRef } from '../native'

/** 构造候选链接（source 固定，resolved 指向旧路径） */
function link(target: string, resolved: WikiLinkRef['resolved'], source = '/w/a.md'): WikiLinkRef {
  return { source, target, heading: '', alias: '', line: 1, text: '', resolved }
}

const OLD = '/w/b.md'
const NEW = '/w/c.md'

describe('rewriteContent', () => {
  test('基础替换：别名与标题锚保留', () => {
    const content = 'see [[b]] and [[b|别名]] and [[b#sec]]'
    const links = [
      link('b', { kind: 'ok', path: OLD }),
      link('b', { kind: 'ok', path: OLD }),
      link('b', { kind: 'ok', path: OLD }),
    ]
    expect(rewriteContent(content, '/w/a.md', links, OLD, NEW)).toBe(
      'see [[c]] and [[c|别名]] and [[c#sec]]',
    )
  })

  test('.md 书写习惯保留', () => {
    const content = '[[b.md]]'
    const links = [link('b.md', { kind: 'ok', path: OLD })]
    expect(rewriteContent(content, '/w/a.md', links, OLD, NEW)).toBe('[[c.md]]')
  })

  test('子目录前缀改写为相对路径（跨目录移动场景）', () => {
    const content = '[[sub/b]] and [[sub/b.md]]'
    const links = [
      link('sub/b', { kind: 'ok', path: '/w/sub/b.md' }),
      link('sub/b.md', { kind: 'ok', path: '/w/sub/b.md' }),
    ]
    // 改名后文件移动到别处（newPath 与原目录不同级）→ ../ 前缀
    expect(rewriteContent(content, '/w/a.md', links, '/w/sub/b.md', '/w2/c.md')).toBe(
      '[[../w2/c]] and [[../w2/c.md]]',
    )
  })

  test('围栏块内不重写', () => {
    const content = '```\n[[b]]\n```'
    const links = [link('b', { kind: 'ok', path: OLD })]
    expect(rewriteContent(content, '/w/a.md', links, OLD, NEW)).toBeNull()
  })

  test('非候选（解析到别处的同名链接）不动', () => {
    const content = '[[b]] and [[b2]]'
    const links = [
      // b2 解析到别的文件（非旧路径）→ 不参与替换
      link('b', { kind: 'ok', path: OLD }),
      link('b2', { kind: 'ok', path: '/w/other.md' }),
    ]
    expect(rewriteContent(content, '/w/a.md', links, OLD, NEW)).toBe('[[c]] and [[b2]]')
  })

  test('无受影响链接返回 null', () => {
    const content = 'plain'
    expect(rewriteContent(content, '/w/a.md', [], OLD, NEW)).toBeNull()
  })
})
