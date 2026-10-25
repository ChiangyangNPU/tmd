import { describe, it, expect } from 'vitest'
import { buildChatMessages, capHistory } from '../ai-chat'
import type { AiChatMessage } from '../native'

/**
 * AI 问答的消息装配：上下文块的拼装与转义、历史截断。
 * 这些决定了「发什么」——上下文只附加在当前一轮，历史存裸问题。
 */

describe('buildChatMessages', () => {
  it('无上下文时只有系统提示词、历史与裸问题', () => {
    const messages = buildChatMessages(
      '什么是 Markdown？',
      {
        selection: null,
        document: null,
        workspace: [],
      },
      [],
    )
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('Markdown editor')
    expect(messages[1]).toEqual({ role: 'user', content: '什么是 Markdown？' })
  })

  it('选区上下文包在 selected_text 标签内', () => {
    const messages = buildChatMessages(
      '解释一下',
      {
        selection: '选中的文字',
        document: null,
        workspace: [],
      },
      [],
    )
    expect(messages.at(-1)!.content).toContain('<selected_text>')
    expect(messages.at(-1)!.content).toContain('选中的文字')
  })

  it('文档上下文带文件名属性', () => {
    const messages = buildChatMessages(
      '总结',
      {
        selection: null,
        document: { name: 'notes.md', content: '# 笔记' },
        workspace: [],
      },
      [],
    )
    expect(messages.at(-1)!.content).toContain('<current_document path="notes.md">')
    expect(messages.at(-1)!.content).toContain('# 笔记')
  })

  it('工作区片段逐条带路径，路径特殊字符被转义', () => {
    const messages = buildChatMessages(
      '引用来源',
      {
        selection: null,
        document: null,
        workspace: [
          { path: 'a&"b".md', name: 'a&"b".md', text: '片段一' },
          { path: 'c.md', name: 'c.md', text: '片段二' },
        ],
      },
      [],
    )
    const content = messages.at(-1)!.content
    expect(content).toContain('<workspace_excerpts>')
    expect(content).toContain('path="a&amp;&quot;b&quot;.md"')
    expect(content).toContain('片段一')
    expect(content).toContain('片段二')
  })

  it('历史夹在系统提示词与当前问题之间，当前问题独享上下文块', () => {
    const history: AiChatMessage[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ]
    const messages = buildChatMessages(
      '第二问',
      {
        selection: '选区',
        document: null,
        workspace: [],
      },
      history,
    )
    expect(messages).toHaveLength(4)
    expect(messages[1]).toEqual({ role: 'user', content: '第一问' })
    expect(messages[2]).toEqual({ role: 'assistant', content: '第一答' })
    expect(messages[3].content).toContain('<selected_text>')
    expect(messages[1].content).not.toContain('<selected_text>')
  })
})

describe('capHistory', () => {
  it('保留最近的消息', () => {
    const history: AiChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `m${i}`,
    }))
    const capped = capHistory(history)
    expect(capped).toHaveLength(12)
    expect(capped[0].content).toBe('m8')
    expect(capped.at(-1)!.content).toBe('m19')
  })

  it('总字符超限时从最旧开始丢弃', () => {
    const history: AiChatMessage[] = [
      { role: 'user', content: 'x'.repeat(40_000) },
      { role: 'assistant', content: 'y'.repeat(40_000) },
      { role: 'user', content: '最新问题' },
    ]
    const capped = capHistory(history)
    // 丢到总字符 ≤ 60_000 为止：最旧的 40k 被丢，其余保留
    expect(capped).toEqual([
      { role: 'assistant', content: 'y'.repeat(40_000) },
      { role: 'user', content: '最新问题' },
    ])
  })
})
