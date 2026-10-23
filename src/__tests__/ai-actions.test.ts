import { describe, it, expect } from 'vitest'
import {
  AI_ACTIONS,
  MAX_SELECTION_CHARS,
  applyAiResult,
  buildActionMessages,
  captureSelection,
  detectScript,
  isSelectionIntact,
  normalizeAiOutput,
  remapSelectionRange,
  translationTarget,
} from '../ai-actions'
import type { CapturedSelection } from '../ai-actions'
import type { EditorView } from '@milkdown/kit/prose/view'

/**
 * AI 选区动作的纯逻辑：提示词、语种判断、输出清洗、选区漂移校验。
 * 这些决定了「发什么」「写回什么」「什么时候不能写」三件事。
 */

/** 构造只含 textBetween / selection 的最小视图（不启动真实编辑器） */
function fakeView(text: string, from = 0, to = text.length, empty = false): EditorView {
  return {
    state: {
      selection: { from, to, empty },
      doc: {
        content: { size: text.length },
        textBetween: () => text,
      },
    },
  } as unknown as EditorView
}

describe('AI_ACTIONS 动作表', () => {
  it('每个动作都有唯一 id、i18n 键与英文指令', () => {
    const ids = AI_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const action of AI_ACTIONS) {
      expect(action.labelKey.startsWith('ai.actions.')).toBe(true)
      expect(action.instruction.length).toBeGreaterThan(20)
    }
  })

  it('覆盖需求约定的七个动作', () => {
    expect(AI_ACTIONS.map((a) => a.id)).toEqual([
      'polish',
      'rewrite',
      'shorten',
      'expand',
      'translate',
      'proofread',
      'normalize',
    ])
  })
})

describe('buildActionMessages', () => {
  it('系统提示词约束只输出替换文本，用户消息即选区原文', () => {
    const messages = buildActionMessages('polish', '你好世界', 'zh-CN')
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Return ONLY the replacement text')
    expect(messages[0].content).toContain('Polish the selected text')
    expect(messages[1]).toEqual({ role: 'user', content: '你好世界' })
  })

  it('翻译动作附带明确目标语种：中文→英文，英文→简体中文', () => {
    const zh = buildActionMessages('translate', '这是一段中文', 'zh-CN')
    expect(zh[0].content).toContain('Target language: English')

    const en = buildActionMessages('translate', 'This is English', 'en')
    expect(en[0].content).toContain('Simplified Chinese')
  })

  it('未知动作抛错（避免把空指令发给模型）', () => {
    expect(() => buildActionMessages('nope' as never, 'x', 'zh-CN')).toThrow('unknown ai action')
  })
})

describe('语种判断', () => {
  it('按字符数区分中日韩与拉丁', () => {
    expect(detectScript('你好世界，这是一段中文')).toBe('cjk')
    expect(detectScript('hello 世界')).toBe('latin')
    expect(detectScript('123 !!!')).toBe('cjk')
  })

  it('中英混排按主体语种判断：夹英文术语的中文仍判为中文', () => {
    // 修复前 cjk >= latin 会把这类文本判成拉丁，导致「中文译成中文」
    expect(detectScript('这个 API 返回 JSON 数据')).toBe('cjk')
    expect(detectScript('Use Git 与 Docker 部署服务')).toBe('latin')
  })

  it('英文界面下中文内容也译成英文', () => {
    expect(translationTarget('中文内容', 'en')).toContain('English')
  })

  it('locale 为 en-US 等变体时同样走英文分支', () => {
    expect(translationTarget('中文内容', 'en-US')).toContain('English')
  })
})

describe('normalizeAiOutput', () => {
  it('剥离模型偶发包裹的整段代码围栏', () => {
    expect(normalizeAiOutput('```markdown\n# 标题\n\n正文\n```')).toBe('# 标题\n\n正文')
    expect(normalizeAiOutput('```\n纯文本\n```')).toBe('纯文本')
  })

  it('保留正文内部代码块，只剥离最外层围栏', () => {
    const input = '前文\n\n```js\nconst a = 1\n```\n\n后文'
    expect(normalizeAiOutput(input)).toBe(input)
  })

  it('统一换行并去掉首尾空白', () => {
    expect(normalizeAiOutput('\r\n  你好  \r\n')).toBe('你好')
  })
})

describe('captureSelection', () => {
  it('无视图 / 空选区 / 纯空白选区都返回 null', () => {
    expect(captureSelection(null)).toBeNull()
    expect(captureSelection(fakeView('abc', 1, 1, true))).toBeNull()
    expect(captureSelection(fakeView('   '))).toBeNull()
  })

  it('返回范围与原文快照', () => {
    expect(captureSelection(fakeView('abc', 1, 3))).toEqual({ from: 1, to: 3, text: 'abc' })
  })
})

describe('isSelectionIntact', () => {
  const selection: CapturedSelection = { from: 0, to: 4, text: '原文内容' }

  it('范围内文本仍一致时通过', () => {
    expect(isSelectionIntact(fakeView('原文内容'), selection)).toBe(true)
  })

  it('文本被改写或范围越界时拒绝（防止覆盖用户新编辑的内容）', () => {
    expect(isSelectionIntact(fakeView('已被改写'), selection)).toBe(false)
    expect(isSelectionIntact(fakeView('原文内容'), { from: 0, to: 99, text: 'x' })).toBe(false)
    expect(isSelectionIntact(fakeView('原文内容'), { from: 2, to: 2, text: '' })).toBe(false)
    expect(isSelectionIntact(null, selection)).toBe(false)
  })
})

/** remapSelectionRange 用的最小文档对象：textBetween 即切片 */
function docLike(text: string) {
  return {
    content: { size: text.length },
    textBetween: (from: number, to: number) => text.slice(from, to),
  }
}

/**
 * 构造「在位置 at 插入 size 个字符」的映射，带 assoc 语义：
 * from 用 assoc=1（跟随后侧内容），to 用 assoc=-1（跟随前侧内容）。
 */
function insertionMapping(at: number, size: number) {
  return {
    map: (pos: number, assoc = 0) => {
      if (pos > at) return pos + size
      if (pos === at) return assoc >= 0 ? pos + size : pos
      return pos
    },
  }
}

describe('remapSelectionRange', () => {
  const selection: CapturedSelection = { from: 6, to: 11, text: 'world' } // "hello world"

  it('选区前的编辑只平移坐标，映射后可继续替换', () => {
    // 在开头插入 "X" → "Xhello world"，world 平移到 [7,12)
    const mapped = remapSelectionRange(docLike('Xhello world'), insertionMapping(0, 1), selection)
    expect(mapped).toEqual({ from: 7, to: 12, text: 'world' })
  })

  it('恰好落在边界的插入不扩大替换范围', () => {
    // 在 from=6 处插入 → 范围整体后移且不含插入内容
    const atFrom = remapSelectionRange(docLike('hello Xworld'), insertionMapping(6, 1), selection)
    expect(atFrom).toEqual({ from: 7, to: 12, text: 'world' })
    // 在 to=11 处插入 → 范围不动且不含插入内容
    const atTo = remapSelectionRange(docLike('hello worldX'), insertionMapping(11, 1), selection)
    expect(atTo).toEqual({ from: 6, to: 11, text: 'world' })
  })

  it('选区内被编辑（映射后文本不一致）返回 null', () => {
    // 在 pos=8（world 内部）插入 → "hello woXrld"
    const mapped = remapSelectionRange(docLike('hello woXrld'), insertionMapping(8, 1), selection)
    expect(mapped).toBeNull()
  })

  it('选区被删除（范围折叠）或越界时返回 null', () => {
    // 删除 [5, 11)：map(6)=5、map(11)=5，范围折叠
    const collapse = { map: (pos: number) => (pos >= 11 ? pos - 6 : pos <= 5 ? pos : 5) }
    expect(remapSelectionRange(docLike('hello'), collapse, selection)).toBeNull()
    // 映射后越界
    expect(
      remapSelectionRange(docLike('hi'), { map: (pos: number) => pos }, {
        from: 0,
        to: 99,
        text: 'hi',
      }),
    ).toBeNull()
  })
})

describe('applyAiResult', () => {
  it('选区漂移或输出为空时不写回', () => {
    const selection: CapturedSelection = { from: 0, to: 4, text: '原文内容' }
    expect(applyAiResult(selection, '新内容', fakeView('已被改写'))).toBe(false)
    expect(applyAiResult(selection, '   ', fakeView('原文内容'))).toBe(false)
  })
})

describe('选区长度上限', () => {
  it('上限为正数，用于拦截误选整篇文档', () => {
    expect(MAX_SELECTION_CHARS).toBeGreaterThan(1000)
  })
})
