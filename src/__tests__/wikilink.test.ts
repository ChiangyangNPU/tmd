/**
 * 双链语法（[[目标]] / [[目标|别名]] / [[目标#标题]]）单元测试：
 * - 纯函数 parseWikiInner / parseWikiText / convertWikiLinks 的切分边界
 * - 真实 unified + remark-gfm 管线的 parse→stringify 往返（序列化 byte-stable）
 * - 输入规则正则与行内代码/公式守卫
 */
import { describe, expect, test } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'
import {
  convertWikiLinks,
  parseWikiInner,
  parseWikiText,
  wikiPlugin,
  WIKI_INPUT_RE,
  type WikiSeg,
} from '../wikilink'

function segShapes(segs: WikiSeg[]): string[] {
  return segs.map((s) =>
    s.kind === 'text' ? `text:${s.value}` : `wiki:${s.target}#${s.heading}|${s.alias}`,
  )
}

/** 构造段落 mdast */
function para(...children: Array<{ type: string; value?: string }>): {
  type: string
  children: Array<{ type: string; value?: string }>
} {
  return { type: 'paragraph', children }
}

describe('parseWikiInner 内部切分', () => {
  test('基础目标', () => {
    expect(parseWikiInner('笔记')).toEqual({ target: '笔记', alias: '', heading: '' })
  })

  test('别名', () => {
    expect(parseWikiInner('Note|显示名')).toEqual({
      target: 'Note',
      alias: '显示名',
      heading: '',
    })
  })

  test('标题锚', () => {
    expect(parseWikiInner('Note#第二章')).toEqual({
      target: 'Note',
      alias: '',
      heading: '第二章',
    })
  })

  test('标题锚 + 别名（# 在 | 之前切分）', () => {
    expect(parseWikiInner('Note#第二章|别名')).toEqual({
      target: 'Note',
      alias: '别名',
      heading: '第二章',
    })
  })

  test('两端空白 trim', () => {
    expect(parseWikiInner(' 笔记 | 名 ')).toEqual({
      target: '笔记',
      alias: '名',
      heading: '',
    })
  })

  test('仅标题锚（自文档跳转）', () => {
    expect(parseWikiInner('#安装')).toEqual({ target: '', alias: '', heading: '安装' })
  })
})

describe('parseWikiText 文本切分', () => {
  test('文本与链接混合', () => {
    expect(segShapes(parseWikiText('见 [[A]] 与 [[B|别]]。'))).toEqual([
      'text:见 ',
      'wiki:A#|',
      'text: 与 ',
      'wiki:B#|别',
      'text:。',
    ])
  })

  test('同段多个链接', () => {
    expect(segShapes(parseWikiText('[[A]][[B]]'))).toEqual(['wiki:A#|', 'wiki:B#|'])
  })

  test('空白内容 [[]] 保持字面', () => {
    expect(segShapes(parseWikiText('a [[]] b'))).toEqual(['text:a [[]] b'])
  })

  test('无链接整段原样', () => {
    expect(segShapes(parseWikiText('普通文本'))).toEqual(['text:普通文本'])
  })

  test('不完整括号不成节点', () => {
    expect(segShapes(parseWikiText('a [[b] c'))).toEqual(['text:a [[b] c'])
  })
})

describe('convertWikiLinks 树遍历', () => {
  test('段落 text 就地替换', () => {
    const tree = para({ type: 'text', value: 'see [[A]] now' })
    convertWikiLinks(tree as never)
    expect(tree.children).toHaveLength(3)
    expect((tree.children[1] as { type: string }).type).toBe('wikilink')
  })

  test('行内代码原子节点不递归', () => {
    const tree = para({ type: 'inlineCode', value: '[[A]]' })
    convertWikiLinks(tree as never)
    expect((tree.children[0] as { type: string }).type).toBe('inlineCode')
  })
})

describe('真实管线 parse→stringify 往返', () => {
  const processor = () =>
    unified().use(remarkParse).use(remarkStringify).use(remarkGfm).use(wikiPlugin)

  const WIKI_RE = /\[\[([^[\\\]\n]+)\]\]/g

  /** 取输出中的全部 wikilink 内部文本 */
  function innerLinks(md: string): string[] {
    return [...md.matchAll(WIKI_RE)].map((m) => m[1])
  }

  test('三件套序列化形态规范化（目标#标题|别名）', () => {
    const out = processor().processSync('x [[Note|名]] y [[Note#第二章]] z [[B#s|n]]').toString()
    expect(innerLinks(out)).toEqual(['Note|名', 'Note#第二章', 'B#s|n'])
  })

  test('输出再次 parse 属性不变（往返稳定）', () => {
    const once = processor().processSync('[[A|甲]] 与 [[B#第二节|乙]]').toString()
    const tree = processor().parse(once) as Root
    convertWikiLinks(tree as never)
    const wikis: Array<{ target: string; alias: string; heading: string }> = []
    const walk = (node: {
      type: string
      children?: { type: string }[]
      target?: string
      alias?: string
      heading?: string
    }) => {
      if (node.type === 'wikilink') {
        wikis.push({
          target: node.target ?? '',
          alias: node.alias ?? '',
          heading: node.heading ?? '',
        })
      }
      for (const child of node.children ?? []) walk(child as never)
    }
    walk(tree as never)
    expect(wikis).toEqual([
      { target: 'A', alias: '甲', heading: '' },
      { target: 'B', alias: '乙', heading: '第二节' },
    ])
  })

  test('行内代码内的 [[..]] 保持字面', () => {
    const out = processor().processSync('code `[[A]]` done').toString()
    expect(out).toContain('`[[A]]`')
    const tree = processor().parse('code `[[A]]` done') as Root
    convertWikiLinks(tree as never)
    let hasWiki = false
    const walk = (node: { type: string; children?: { type: string }[] }) => {
      if (node.type === 'wikilink') hasWiki = true
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    expect(hasWiki).toBe(false)
  })

  test('标题锚序列化到文首（frontmatter 文档不受影响）', () => {
    const out = processor().processSync('---\ntitle: t\n---\n\n[[A]]').toString()
    expect(innerLinks(out)).toEqual(['A'])
  })
})

describe('输入规则正则', () => {
  test('闭合 ]] 触发', () => {
    expect(WIKI_INPUT_RE.test('看 [[Note|名]]')).toBe(true)
    expect(WIKI_INPUT_RE.exec('看 [[Note|名]]')?.[1]).toBe('Note|名')
  })

  test('未闭合不触发', () => {
    expect(WIKI_INPUT_RE.test('看 [[Note|名]')).toBe(false)
    expect(WIKI_INPUT_RE.test('看 [[Note')).toBe(false)
  })
})
