/**
 * 扩展行内标记（==高亮== / ^上标^ / ~下标~）单元测试：
 * - 纯函数 parseInlineExts / convertInlineExts 的切分边界
 * - 真实 unified + remark-gfm 管线的 parse→stringify 往返
 */
import { describe, expect, test } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'
import {
  convertInlineExts,
  inlineExtPlugin,
  inUnclosedSpan,
  parseInlineExts,
  FOOTNOTE_REF_RE,
  FOOTNOTE_DEF_RE,
  type ExtMdNode,
} from '../mark-ext'

/** 压缩节点序列为「类型:值」便于断言 */
function shapes(nodes: ExtMdNode[]): string[] {
  return nodes.map((n) =>
    n.type === 'text'
      ? `text:${n.value}`
      : `${n.type}:${(n.children?.[0] as ExtMdNode)?.value ?? ''}`,
  )
}

describe('parseInlineExts 成对切分', () => {
  test('==高亮==', () => {
    expect(shapes(parseInlineExts('a==b==c'))).toEqual(['text:a', 'highlight:b', 'text:c'])
  })

  test('^上标^ 与 ~下标~（Pandoc 单符号）', () => {
    expect(shapes(parseInlineExts('x^2^'))).toEqual(['text:x', 'superscript:2'])
    expect(shapes(parseInlineExts('H~2~O'))).toEqual(['text:H', 'subscript:2', 'text:O'])
  })

  test('^{} / _{} 花括号写法', () => {
    expect(shapes(parseInlineExts('x^{2}'))).toEqual(['text:x', 'superscript:2'])
    expect(shapes(parseInlineExts('H_{2}O'))).toEqual(['text:H', 'subscript:2', 'text:O'])
  })

  test('奇数分隔符不配对，整段保留', () => {
    expect(shapes(parseInlineExts('a == b'))).toEqual(['text:a == b'])
    expect(shapes(parseInlineExts('2^3'))).toEqual(['text:2^3'])
    expect(shapes(parseInlineExts('a~b'))).toEqual(['text:a~b'])
  })

  test('空内容不产生标记（==== / ^^ / ~~）', () => {
    expect(shapes(parseInlineExts('===='))).toEqual(['text:===='])
    expect(shapes(parseInlineExts('^^'))).toEqual(['text:^^'])
    expect(shapes(parseInlineExts('~~'))).toEqual(['text:~~'])
  })

  test('单符号内容含空白不配对，花括号允许空白', () => {
    expect(shapes(parseInlineExts('^a b^'))).toEqual(['text:^a b^'])
    expect(shapes(parseInlineExts('^{a b}'))).toEqual(['superscript:a b'])
  })

  test('多语法混合共存', () => {
    expect(shapes(parseInlineExts('x^2^ 与 ==高亮== 与 H~2~O'))).toEqual([
      'text:x',
      'superscript:2',
      'text: 与 ',
      'highlight:高亮',
      'text: 与 H',
      'subscript:2',
      'text:O',
    ])
  })

  test('花括号嵌套花括号不匹配（保守）', () => {
    expect(shapes(parseInlineExts('^{a{b}c}'))).toEqual(['text:^{a{b}c}'])
  })
})

describe('convertInlineExts 树遍历', () => {
  test('段落内 text 被就地替换', () => {
    const tree: ExtMdNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a==b==c' }] }],
    }
    convertInlineExts(tree)
    const para = tree.children![0]
    expect(para.children!.map((c) => c.type)).toEqual(['text', 'highlight', 'text'])
  })

  test('无 children 的原子节点（行内代码）不递归、不报错', () => {
    const code: ExtMdNode = { type: 'inlineCode', value: 'a^b^' }
    const tree: ExtMdNode = { type: 'root', children: [{ type: 'paragraph', children: [code] }] }
    convertInlineExts(tree)
    expect(code).toEqual({ type: 'inlineCode', value: 'a^b^' })
  })

  test('delete 节点内的纯文本不受影响（~~ 已被解析层剥离）', () => {
    const tree: ExtMdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'delete', children: [{ type: 'text', value: 'x' }] }],
        },
      ],
    }
    convertInlineExts(tree)
    const del = tree.children![0].children![0]
    expect(del.type).toBe('delete')
    expect(del.children![0]).toEqual({ type: 'text', value: 'x' })
  })

  test('带源码时单波浪 delete 纠正为 subscript，双波浪保持 delete', () => {
    const source = '前~~删除~~后~下标~尾'
    const parsed = unified().use(remarkParse).use(remarkGfm).parse(source) as never as ExtMdNode
    convertInlineExts(parsed, source)
    const seq = parsed.children![0].children!.map((c) => c.type)
    expect(seq).toEqual(['text', 'delete', 'text', 'subscript', 'text'])
  })

  test('含空白的单波浪保守保持 delete（~a b~）', () => {
    const source = '~a b~'
    const parsed = unified().use(remarkParse).use(remarkGfm).parse(source) as never as ExtMdNode
    convertInlineExts(parsed, source)
    expect(parsed.children![0].children![0].type).toBe('delete')
  })
})

/** 与编辑器一致的解析/序列化管线（gfm 在前，扩展插件在后） */
const processor = unified()
  .use(remarkParse)
  .use(remarkStringify)
  .use(remarkGfm)
  .use(inlineExtPlugin)

function roundtrip(input: string): string {
  return processor.processSync(input).toString().trim()
}

describe('unified 管线往返', () => {
  test('==高亮== 往返', () => {
    expect(roundtrip('这是 ==高亮== 文本')).toBe('这是 ==高亮== 文本')
  })

  test('花括号输入统一序列化为 Pandoc 单符号', () => {
    expect(roundtrip('x^{2}')).toBe('x^2^')
    expect(roundtrip('H_{2}O')).toBe('H~2~O')
  })

  test('上下标往返', () => {
    expect(roundtrip('x^2^ 和 H~2~O')).toBe('x^2^ 和 H~2~O')
  })

  test('删除线与下标共存互不干扰', () => {
    expect(roundtrip('前~~删除~~后~下标~尾')).toBe('前~~删除~~后~下标~尾')
  })

  test('行内代码中的分隔符原样保留', () => {
    expect(roundtrip('代码 `a^b^ c==d==` 结束')).toBe('代码 `a^b^ c==d==` 结束')
  })

  test('奇数分隔符原样保留', () => {
    expect(roundtrip('a == b 和 2^3')).toBe('a == b 和 2^3')
  })

  test('transform 后 mdast 含自定义节点', async () => {
    const tree = (await processor.run(processor.parse('==x=='))) as Root
    const types = (tree.children[0] as { children: { type: string }[] }).children.map((c) => c.type)
    expect(types).toContain('highlight')
  })
})

describe('inUnclosedSpan 输入规则围栏守卫', () => {
  test('未闭合反引号：前方有奇数个未转义 `（闭合符尚未键入也拦截）', () => {
    // 在 `m^2^ 输入到第二个 ^ 的瞬间，闭合 ` 还没打：before=`m^2
    expect(inUnclosedSpan('`m^2')).toBe(true)
    expect(inUnclosedSpan('`==x')).toBe(true)
  })

  test('未闭合美元符：公式 $a^{b} 输入到 } 的瞬间', () => {
    expect(inUnclosedSpan('$a^{b')).toBe(true)
  })

  test('围栏已平衡（偶数）不拦截', () => {
    expect(inUnclosedSpan('`code` 后 x^2')).toBe(false)
    expect(inUnclosedSpan('$a$ 与 x^2')).toBe(false)
    // 双反引号围栏一次出现两个，计数为偶
    expect(inUnclosedSpan('``code`` x^2')).toBe(false)
  })

  test('无任何围栏符的普通段落不拦截', () => {
    expect(inUnclosedSpan('售价 5 元，x^2')).toBe(false)
    expect(inUnclosedSpan('H~2~O')).toBe(false)
  })

  test('转义的围栏符不计入（\\` 与 \\$ 场景）', () => {
    expect(inUnclosedSpan('\\`x^2')).toBe(false)
    expect(inUnclosedSpan('\\$5，x^2')).toBe(false)
  })

  test('偶数个反斜杠不构成转义（\\\\$ 的 $ 仍计入围栏）', () => {
    expect(inUnclosedSpan('\\\\$a^{b')).toBe(true)
  })
})

describe('脚注输入规则正则', () => {
  test('引用：[^label] 行内匹配，label 取中段', () => {
    const m = '正文[^1]'.match(FOOTNOTE_REF_RE)
    expect(m?.[2]).toBe('1')
    expect('见脚注[^note-a]'.match(FOOTNOTE_REF_RE)?.[2]).toBe('note-a')
  })

  test('引用负例：普通链接、无 ^ 前缀、label 含空白或闭合括号不匹配', () => {
    expect('[1]'.match(FOOTNOTE_REF_RE)).toBeNull()
    expect('[链接](url)'.match(FOOTNOTE_REF_RE)).toBeNull()
    expect('[^ a]'.match(FOOTNOTE_REF_RE)).toBeNull()
    expect('[^a]b]'.match(FOOTNOTE_REF_RE)).toBeNull()
  })

  test('定义：占位形态（行首为脚注引用节点）与字面形态均匹配', () => {
    // 正常输入流：[^1] 已被引用规则转为原子节点，textBefore 以 \ufffc 占位
    const m1 = '\ufffc: '.match(FOOTNOTE_DEF_RE)
    expect(m1?.[1]).toBe('\ufffc')
    // 字面文本形态（粘贴纯文本后补冒号）
    const m2 = '[^1]: '.match(FOOTNOTE_DEF_RE)
    expect(m2?.[1]).toBe('[^1]')
    expect(m2?.[2]).toBe('1')
    expect('[^ref-x]: '.match(FOOTNOTE_DEF_RE)?.[2]).toBe('ref-x')
  })

  test('定义负例：缺空格、段内有其他文本（$ 锚保护）不匹配', () => {
    expect('\ufffc:'.match(FOOTNOTE_DEF_RE)).toBeNull()
    expect('[^1]:'.match(FOOTNOTE_DEF_RE)).toBeNull()
    // 已有正文的段落不会整段误转（textBefore + 输入以 ^…$ 锚定）
    expect('正文[^1]: '.match(FOOTNOTE_DEF_RE)).toBeNull()
  })
})
