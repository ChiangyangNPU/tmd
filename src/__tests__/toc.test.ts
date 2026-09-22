import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { convertTocBlocks, slugify, fillTocBlocks } from '../toc'

/** 测试用最小 schema：doc > block+，含 paragraph / heading(level attr) */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
  },
})

type MdNode = { type: string; value?: string | null; children?: MdNode[] }

const para = (value: string): MdNode => ({ type: 'paragraph', children: [{ type: 'text', value }] })
const html = (value: string): MdNode => ({ type: 'html', value })

describe('slugify', () => {
  it('小写、空白转连字符、去标点、保留中文', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify('  多 个  空白 ')).toBe('多-个-空白')
    expect(slugify('A.B/C')).toBe('abc')
  })
})

describe('convertTocBlocks', () => {
  it('正常区间合并为 toc 节点', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('<!-- TOC -->'), para('<!-- /TOC -->'), para('正文')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toEqual([{ type: 'toc' }, para('正文')])
  })

  it('未闭合标记不转换、后续内容保留（防数据丢失）', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('<!-- TOC -->'), para('正文内容'), para('结尾')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toEqual([para('<!-- TOC -->'), para('正文内容'), para('结尾')])
  })

  it('开标记混有正文不识别', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('说明 <!-- TOC -->'), para('<!-- /TOC -->')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toHaveLength(2)
    expect(tree.children![0]).not.toEqual({ type: 'toc' })
  })

  it('开标记后拖正文（无闭合同段）不识别', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('<!-- TOC --> 说明文字'), para('<!-- /TOC -->')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toHaveLength(2)
  })

  it('开闭同段只允许纯标记，夹带文字不识别', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('<!-- TOC --> x <!-- /TOC -->'), para('正文')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toHaveLength(2)
  })

  it('闭合段落混有正文时该闭合无效', () => {
    const tree: MdNode = {
      type: 'root',
      children: [para('<!-- TOC -->'), para('<!-- /TOC --> 尾巴')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toHaveLength(2)
    expect(tree.children![0]).not.toEqual({ type: 'toc' })
  })

  it('html 节点与 paragraph 节点均可识别', () => {
    const tree: MdNode = {
      type: 'root',
      children: [html('<!-- TOC -->'), html('<!-- /TOC -->')],
    }
    convertTocBlocks(tree)
    expect(tree.children!).toEqual([{ type: 'toc' }])
  })

  it('嵌套容器内同样生效', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'blockquote',
          children: [para('<!-- TOC -->'), para('<!-- /TOC -->'), para('内部正文')],
        },
        para('外部正文'),
      ],
    }
    convertTocBlocks(tree)
    const quote = tree.children![0] as MdNode
    expect(quote.children).toEqual([{ type: 'toc' }, para('内部正文')])
  })
})

describe('fillTocBlocks', () => {
  const makeDoc = (levels: number[], texts: string[]) => {
    const children = levels.map((lv, i) =>
      schema.node('heading', { level: lv }, schema.text(texts[i])),
    )
    return schema.node('doc', null, children)
  }

  it('用当前标题填充链接列表，开闭标记间的旧内容被替换', () => {
    const doc = makeDoc([1, 2], ['甲', '乙'])
    const md = '<!-- TOC -->\n\n旧列表\n\n<!-- /TOC -->'
    const out = fillTocBlocks(md, doc)
    expect(out).toBe('<!-- TOC -->\n\n- [甲](#甲)\n  - [乙](#乙)\n\n<!-- /TOC -->')
  })

  it('无标题时列表为空', () => {
    const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('x')))
    expect(fillTocBlocks('<!-- TOC -->\n\n<!-- /TOC -->', doc)).toBe(
      '<!-- TOC -->\n\n\n\n<!-- /TOC -->',
    )
  })

  it('兼容 remark-stringify 的行首反斜杠转义', () => {
    const doc = makeDoc([1], ['甲'])
    const out = fillTocBlocks('\\<!-- TOC -->\n\n\\<!-- /TOC -->', doc)
    expect(out).toBe('<!-- TOC -->\n\n- [甲](#甲)\n\n<!-- /TOC -->')
  })

  it('同名标题加 -1 计数后缀，链接文本转义方括号', () => {
    const doc = makeDoc([1, 1, 1], ['同名', '同名', '[特殊] 标题'])
    const md = '<!-- TOC -->\n\n<!-- /TOC -->'
    const out = fillTocBlocks(md, doc)
    expect(out).toContain('- [同名](#同名)')
    expect(out).toContain('- [同名](#同名-1)')
    expect(out).toContain('- [\\[特殊\\] 标题](#特殊-标题)')
  })

  it('标题含 $& / $` 等替换模式字符时按原文输出', () => {
    const doc = makeDoc([1], ['价格 $& 与 $` 说明'])
    const out = fillTocBlocks('<!-- TOC -->\n\n<!-- /TOC -->', doc)
    expect(out).toContain('- [价格 $& 与 $` 说明](')
  })
})
