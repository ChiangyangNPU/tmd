import { describe, it, expect, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import { safeTextHandler, patchTextEscaping, stripPipeBreakEscaping } from '../text-escaping'

describe('safeTextHandler（恒定转义的文本序列化）', () => {
  const mkState = () => {
    const safe = vi.fn((value: string) => `SAFE(${value})`)
    return { state: { safe }, safe }
  }

  it('末尾为空白、不含 *_\\ 的文本仍交给 safe() —— 不再原样返回', () => {
    // milkdown 原 handler 会对该形态早退原样输出，导致表格单元格里的 | 漏转义
    const { state, safe } = mkState()
    const out = safeTextHandler({ value: '|2x2| ' }, null, state, { before: '', after: '|' })
    expect(safe).toHaveBeenCalledTimes(1)
    expect(out).toBe('SAFE(|2x2| )')
  })

  it('原样透传 value 与 info（附 encode: [] 保持 milkdown 设定）', () => {
    const { state, safe } = mkState()
    safeTextHandler({ value: 'a|b' }, null, state, { before: 'x', after: 'y' })
    expect(safe).toHaveBeenCalledWith('a|b', { before: 'x', after: 'y', encode: [] })
  })

  it('空文本也走 safe()（交由底层决定输出）', () => {
    const { state, safe } = mkState()
    safeTextHandler({ value: '' }, null, state, {})
    expect(safe).toHaveBeenCalledWith('', { encode: [] })
  })
})

describe('patchTextEscaping', () => {
  /** 伪造 Ctx：捕获 update 的变换函数并应用到给定 prev 上 */
  const mkCtx = (prev: unknown) => {
    let updater: ((v: unknown) => unknown) | null = null
    const ctx = {
      update: (_slice: unknown, fn: (v: unknown) => unknown) => {
        updater = fn
      },
    }
    return { ctx, run: () => updater?.(prev) }
  }

  it('覆盖 text handler，同时保留 strong/emphasis 与其它选项', () => {
    const strongHandler = () => 'S'
    const emphasisHandler = () => 'E'
    const prev = {
      handlers: { text: () => 'old', strong: strongHandler, emphasis: emphasisHandler },
      encode: [],
    }
    const { ctx, run } = mkCtx(prev)
    patchTextEscaping(ctx as never)
    const next = run() as typeof prev
    expect(next.handlers.text).toBe(safeTextHandler)
    expect(next.handlers.strong).toBe(strongHandler)
    expect(next.handlers.emphasis).toBe(emphasisHandler)
    expect(next.encode).toEqual([])
  })

  it('handlers 缺失时也能安全补上 text', () => {
    const { ctx, run } = mkCtx({ encode: [] })
    patchTextEscaping(ctx as never)
    const next = run() as { handlers: { text: unknown }; encode: unknown }
    expect(next.handlers.text).toBe(safeTextHandler)
    expect(next.encode).toEqual([])
  })
})

describe('stripPipeBreakEscaping（取消行首管道符保守转义）', () => {
  /** toMarkdown 扩展/unsafe 规则的最小结构（仅断言用到的字段） */
  interface UnsafeRuleShape {
    atBreak?: boolean
    character?: string
  }
  interface ToMdExtShape {
    unsafe?: UnsafeRuleShape[]
    extensions?: ToMdExtShape[]
  }
  /** mdast 节点最小结构（transform 改单元格内容用） */
  interface MdNodeShape {
    type: string
    value?: string
    children?: MdNodeShape[]
  }

  /** 递归收集 toMarkdown 扩展链上的 unsafe 规则（精简为 atBreak:character 串） */
  const collectRules = (exts: ToMdExtShape[]): string[] => {
    const rules: string[] = []
    for (const ext of exts) {
      for (const rule of ext.unsafe ?? [])
        rules.push(`${rule.atBreak ? 'B' : '-'}:${rule.character}`)
      if (ext.extensions) rules.push(...collectRules(ext.extensions))
    }
    return rules
  }

  it('attacher 后仅移除 atBreak 的 | 规则，保留 tableCell 内 | 转义', () => {
    const processor = unified().use(remarkGfm).use(stripPipeBreakEscaping).freeze()
    const rules = collectRules((processor.data().toMarkdownExtensions as ToMdExtShape[]) ?? [])
    expect(rules).not.toContain('B:|')
    // db54686 修复依赖的单元格内管道符转义规则必须保留
    expect(rules).toContain('-:|')
  })

  /** parse→stringify 完整往返（attacher 须在 gfm 之后注册） */
  const roundtrip = (input: string): string =>
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(stripPipeBreakEscaping)
      .use(remarkStringify)
      .processSync(input)
      .toString()
      .replace(/\n+$/, '')

  /** 顶层块类型序列，用于断言没有意外成表 */
  const shape = (input: string): string =>
    JSON.stringify(
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        .parse(input)
        .children.map((n) => n.type),
    )

  it('单行管道文本保持原样，不再输出反斜杠', () => {
    expect(roundtrip('| 55 | 55 |')).toBe('| 55 | 55 |')
  })

  it('二次往返幂等，且段落不会意外成表', () => {
    const once = roundtrip('| 55 | 55 |\n') + '\n'
    expect(roundtrip(once)).toBe('| 55 | 55 |')
    expect(shape(once)).toBe('["paragraph"]')
  })

  it('正常表格序列化完全不变', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(roundtrip(table)).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(shape(table)).toBe('["table"]')
  })

  it('表格单元格内的字面 | 仍被转义（db54686 回归保护）', () => {
    // 源码里的转义管道符往返保持
    const out = roundtrip('| a | b |\n| --- | --- |\n| x\\|y | 2 |')
    expect(out).toContain('x\\|y')

    // 复刻 db54686 场景：mdast 单元格文本直接含裸 | 且以空格结尾
    // （ProseMirror doc 转出的 mdast 形态，不经 markdown 解析）
    const out2 = unified()
      .use(remarkParse)
      .use(remarkGfm)
      // 把第二行第一个单元格内容替换为含裸 | 的文本
      .use(() => (tree: MdNodeShape) => {
        tree.children![0].children![1].children![0].children = [{ type: 'text', value: '|2x2| ' }]
      })
      .use(stripPipeBreakEscaping)
      .use(remarkStringify)
      .processSync('| a | b |\n| --- | --- |\n| old | c |')
      .toString()
    expect(out2).toContain('\\|2x2\\|')
  })

  it('引用 / 列表 / 硬换行后的行首管道同样不转义，结构保持', () => {
    const quote = '> | 55 | 55 |'
    expect(roundtrip(quote)).toBe(quote)
    expect(shape(quote)).toContain('blockquote')

    expect(roundtrip('- | 55 | 55 |')).toBe('* | 55 | 55 |')

    const br = 'a  \n| 55 | 55 |'
    expect(roundtrip(br)).toBe('a\\\n| 55 | 55 |')
    expect(shape(br)).toBe('["paragraph"]')
  })

  it('两个管道段落（空行阻断）均不转义，且不会合并成表', () => {
    const two = '| a |\n\n| - |'
    expect(roundtrip(two)).toBe(two)
    expect(shape(two)).toBe('["paragraph","paragraph"]')
  })

  it('紧邻分隔行仍按 GFM 解析为表格（输出走 table handler，不受影响）', () => {
    const table = '| a |\n| - |'
    expect(shape(table)).toBe('["table"]')
    expect(roundtrip(table)).toBe(table)
  })
})
