import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import {
  convertFrontMatter,
  frontmatterPlugin,
  parseFrontMatterProps,
  validateFrontMatter,
  type FmMdNode,
} from '../frontmatter'

/** 真实 unified 管线往返（插件内部已含 remark-frontmatter 注册） */
function roundtrip(markdown: string): string {
  const processor = unified().use(remarkParse).use(remarkStringify).use(frontmatterPlugin)
  return processor.processSync(markdown).toString()
}

describe('parseFrontMatterProps', () => {
  it('解析顶层简单键值', () => {
    const r = parseFrontMatterProps('---\ntitle: 标题\ndate:\n---')
    expect(r.invalid).toBe(false)
    expect(r.entries).toEqual([
      { key: 'title', value: '标题' },
      { key: 'date', value: '' },
    ])
  })

  it('成对引号去除，不成对保留', () => {
    const r = parseFrontMatterProps('---\na: "hello"\nb: \'x\'' + "\nc: it's ok\n---")
    expect(r.entries.map((e) => e.value)).toEqual(['hello', 'x', "it's ok"])
  })

  it('注释行与空行跳过', () => {
    const r = parseFrontMatterProps('---\n# 注释\n\ntitle: a # 行内保留\n---')
    expect(r.entries).toEqual([{ key: 'title', value: 'a # 行内保留' }])
  })

  it('顶层数组与缩进续行标记为 complex', () => {
    const r = parseFrontMatterProps('---\ntitle: a\ntags:\n  - x\n  - y\n---')
    expect(r.complex).toBe(true)
    expect(r.entries).toEqual([
      { key: 'title', value: 'a' },
      { key: 'tags', value: '' },
    ])
  })

  it('无法识别的顶层行标记 invalid', () => {
    expect(parseFrontMatterProps('---\n这不是键值\n---').invalid).toBe(true)
  })

  it('缺少起始/闭合围栏整体 invalid', () => {
    expect(parseFrontMatterProps('title: a\n---').invalid).toBe(true)
    expect(parseFrontMatterProps('---\ntitle: a').invalid).toBe(true)
  })
})

describe('validateFrontMatter', () => {
  it('首尾围栏完整即合法（... 结束也认可）', () => {
    expect(validateFrontMatter('---\ntitle: a\n---')).toBe(true)
    expect(validateFrontMatter('---\ntitle: a\n...')).toBe(true)
  })

  it('缺围栏不合法', () => {
    expect(validateFrontMatter('title: a')).toBe(false)
    expect(validateFrontMatter('--\ntitle: a\n---')).toBe(false)
  })
})

describe('convertFrontMatter', () => {
  /** 构造带 position 的最小 yaml 树 */
  function treeWithYaml(source: string): FmMdNode {
    const end = source.indexOf('\n', source.indexOf('\n') + 1) + 3 // 闭合 --- 末
    return {
      type: 'root',
      children: [
        {
          type: 'yaml',
          value: 'title: a',
          position: { start: { offset: 0 }, end: { offset: end } },
        },
        {
          type: 'paragraph',
          position: { start: { offset: source.indexOf('正文') }, end: { offset: source.length } },
        },
      ],
    }
  }

  it('yaml 节点转为 frontmatter，value 为围栏起到下一块前的原文', () => {
    const source = '---\ntitle: a\n---\n\n正文'
    const tree = treeWithYaml(source)
    convertFrontMatter(tree, source)
    const node = tree.children![0]
    expect(node.type).toBe('frontmatter')
    // 含闭合后一个空行（两个 LF），去掉尾 LF 后剩一个，序列化时 join 补回
    expect(node.value).toBe('---\ntitle: a\n---\n')
  })

  it('无源码时退化为标准围栏拼接', () => {
    const tree: FmMdNode = {
      type: 'root',
      children: [{ type: 'yaml', value: 'title: a' }],
    }
    convertFrontMatter(tree)
    expect(tree.children![0]).toMatchObject({
      type: 'frontmatter',
      value: '---\ntitle: a\n---',
    })
  })
})

describe('frontmatter 解析/序列化往返', () => {
  it('空行分隔的 front matter 字节级往返', () => {
    const md = '---\ntitle: a\n---\n\n正文\n'
    expect(roundtrip(md)).toBe(md)
  })

  it('无空行紧接正文同样保持单换行', () => {
    const md = '---\ntitle: a\n---\n正文\n'
    expect(roundtrip(md)).toBe(md)
  })

  it('仅 front matter 无正文', () => {
    const md = '---\ntitle: a\n---\n'
    expect(roundtrip(md)).toBe(md)
  })

  it('CRLF：围栏内与块间隔的 CRLF 原样保留', () => {
    // 围栏起到正文之间的 CRLF 字节复原；文档最末换行由 remark 全局规范化为 LF
    // （无 front matter 的纯正文 CRLF 同样如此，非本插件引入的行为变化）
    expect(roundtrip('---\r\ntitle: a\r\n---\r\n正文\r\n')).toBe('---\r\ntitle: a\r\n---\r\n正文\n')
  })

  it('多行复杂 YAML（数组/缩进/注释/引号）原样往返', () => {
    const md = '---\ntitle: 标题\ntags:\n  - a\n  - b\n---\n\n# 标题\n'
    expect(roundtrip(md)).toBe(md)
  })

  it('正文中间的 --- 不被当作 front matter 吞掉', () => {
    const out = roundtrip('前文\n\n---\n\n后文\n')
    expect(out).toContain('前文')
    expect(out).toContain('后文')
  })

  it('front matter 之后可正常接多级标题与段落', () => {
    const md = '---\ntitle: a\n---\n\n# H1\n\n正文段落\n'
    expect(roundtrip(md)).toBe(md)
  })
})
