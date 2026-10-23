import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'

/**
 * ipc-ai.cjs 的入参校验与请求编排：
 * 消息角色白名单、长度上限、未启用时拒绝、requestId 透传到事件流。
 * 这些是渲染层 → 主进程 → 外部服务商的信任边界，必须逐条锁死。
 */

interface IpcModule {
  sanitizeMessages(raw: unknown): { role: string; content: string }[]
  sanitizeTexts(raw: unknown): string[]
  MAX_MESSAGE_CHARS: number
  MAX_TOTAL_CHARS: number
  MAX_EMBED_TEXT_CHARS: number
  registerAiIpc(deps: Record<string, unknown>): void
}

const require = createRequire(import.meta.url)
const {
  sanitizeMessages,
  sanitizeTexts,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_EMBED_TEXT_CHARS,
  registerAiIpc,
} = require('../../electron/ipc-ai.cjs') as IpcModule
const state = require('../../electron/app-state.cjs') as {
  setMainWindow: (win: unknown) => void
}
const IPC = require('../../electron/ipc.cjs') as Record<string, string>

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** 假主窗口：sender 校验要求 event.sender 与主窗口 webContents 严格同一对象 */
const mainWc = { id: 'main-web-contents' }
const mainEvent = { sender: mainWc }

beforeEach(() => {
  state.setMainWindow({ isDestroyed: () => false, webContents: mainWc })
})

afterEach(() => {
  state.setMainWindow(null)
})

/** 收集注册的 handler（与主进程真实装配同构，仅替换依赖） */
function setup(overrides: { enabled?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const chat = vi.fn(
    async ({ requestId, onEvent }: { requestId: string; onEvent: (e: unknown) => void }) => {
      onEvent({ type: 'delta', text: 'hi' })
      onEvent({ type: 'done' })
      void requestId
      return { content: 'hi' }
    },
  )
  const embed = vi.fn(async ({ texts }: { texts: string[] }) => ({
    vectors: texts.map((t) => [t.length, 1]),
  }))
  const sendToRenderer = vi.fn()
  registerAiIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
    IPC,
    aiConfig: {
      read: () => ({ enabled: overrides.enabled !== false }),
      publicView: () => ({ enabled: true, hasApiKey: false, providers: [] }),
      save: (patch: unknown) => ({ saved: patch }),
    },
    aiClient: {
      chat,
      embed,
      test: async () => ({ ok: true, latencyMs: 1 }),
      abort: (id: string) => id === 'live',
    },
    sendToRenderer,
  })
  return { handlers, chat, embed, sendToRenderer }
}

describe('消息入参校验', () => {
  it('接受合法三方角色并原样返回', () => {
    const messages = sanitizeMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('拒绝空数组、非数组与非法角色（不透传任意字段给上游）', () => {
    expect(() => sanitizeMessages([])).toThrow('invalid messages')
    expect(() => sanitizeMessages('x')).toThrow('invalid messages')
    expect(() => sanitizeMessages([{ role: 'tool', content: 'x' }])).toThrow('invalid role')
    expect(() => sanitizeMessages([{ role: 'user', content: 'a', extra: 1 }])).not.toThrow()
  })

  it('拒绝空内容与超长内容', () => {
    expect(() => sanitizeMessages([{ role: 'user', content: '' }])).toThrow('invalid content')
    expect(() =>
      sanitizeMessages([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }]),
    ).toThrow('message too large')
  })

  it('拒绝合计超限的请求（防止整篇文档灌进上下文）', () => {
    const chunk = 'x'.repeat(MAX_MESSAGE_CHARS)
    const messages = Array.from({ length: MAX_TOTAL_CHARS / MAX_MESSAGE_CHARS + 1 }, () => ({
      role: 'user',
      content: chunk,
    }))
    expect(() => sanitizeMessages(messages)).toThrow('request too large')
  })
})

describe('对话 IPC 编排', () => {
  it('未启用时直接拒绝，不触发网络请求', () => {
    const { handlers, chat } = setup({ enabled: false })
    const result = handlers.get(IPC.aiChat)!(mainEvent, {
      requestId: 'r',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'disabled' } })
    expect(chat).not.toHaveBeenCalled()
  })

  it('参数非法时返回结构化错误而不抛异常', () => {
    const { handlers } = setup()
    expect(handlers.get(IPC.aiChat)!(mainEvent, { messages: [] })).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    expect(
      handlers.get(IPC.aiChat)!(mainEvent, {
        requestId: '',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  })

  it('立即返回 requestId，增量事件带 requestId 推回渲染层', async () => {
    const { handlers, sendToRenderer } = setup()
    const result = handlers.get(IPC.aiChat)!(mainEvent, {
      requestId: 'req-1',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result).toEqual({ ok: true, requestId: 'req-1' })
    // 等待异步流结束
    await vi.waitFor(() =>
      expect(sendToRenderer).toHaveBeenCalledWith(
        IPC.aiStream,
        expect.objectContaining({ type: 'done' }),
      ),
    )
    expect(sendToRenderer).toHaveBeenCalledWith(IPC.aiStream, {
      requestId: 'req-1',
      type: 'delta',
      text: 'hi',
    })
  })

  it('上游异常转成 error 事件而不是未捕获拒绝', async () => {
    const { handlers, sendToRenderer, chat } = setup()
    chat.mockImplementationOnce(async () => {
      const err = new Error('boom')
      Object.assign(err, { code: 'server-error' })
      throw err
    })
    handlers.get(IPC.aiChat)!(mainEvent, {
      requestId: 'req-2',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await vi.waitFor(() =>
      expect(sendToRenderer).toHaveBeenCalledWith(
        IPC.aiStream,
        expect.objectContaining({
          requestId: 'req-2',
          type: 'error',
          code: 'server-error',
          message: 'boom',
        }),
      ),
    )
  })

  it('中止只对在途请求返回 true', () => {
    const { handlers } = setup()
    expect(handlers.get(IPC.aiAbort)!(mainEvent, 'live')).toBe(true)
    expect(handlers.get(IPC.aiAbort)!(mainEvent, 'gone')).toBe(false)
    expect(handlers.get(IPC.aiAbort)!(mainEvent, 42)).toBe(false)
  })

  it('保存配置时拒绝非对象入参', () => {
    const { handlers } = setup()
    expect(() => handlers.get(IPC.aiSaveConfig)!(mainEvent, 'nope')).toThrow('invalid config')
  })
})

describe('嵌入文本入参校验', () => {
  it('接受合法文本列表并原样返回', () => {
    expect(sanitizeTexts(['第一段', 'second block'])).toEqual(['第一段', 'second block'])
  })

  it('拒绝空列表、非字符串、空串与超长文本', () => {
    expect(() => sanitizeTexts([])).toThrow('invalid texts')
    expect(() => sanitizeTexts('x')).toThrow('invalid texts')
    expect(() => sanitizeTexts([42])).toThrow('invalid text')
    expect(() => sanitizeTexts([''])).toThrow('invalid text')
    expect(() => sanitizeTexts(['x'.repeat(MAX_EMBED_TEXT_CHARS + 1)])).toThrow('text too large')
  })
})

describe('嵌入 IPC 编排', () => {
  it('按输入顺序返回向量；未启用时结构化拒绝', async () => {
    const enabled = setup()
    const result = await enabled.handlers.get(IPC.aiEmbed)!(mainEvent, ['a', 'bb'])
    expect(result).toEqual({ ok: true, vectors: [
      [1, 1],
      [2, 1],
    ] })
    expect(enabled.embed).toHaveBeenCalledWith({ texts: ['a', 'bb'] })

    const disabled = setup({ enabled: false })
    const refused = await disabled.handlers.get(IPC.aiEmbed)!(mainEvent, ['a'])
    expect(refused).toMatchObject({ ok: false, error: { code: 'disabled' } })
    expect(disabled.embed).not.toHaveBeenCalled()
  })

  it('入参非法与上游异常都返回结构化错误而不抛异常', async () => {
    const { handlers, embed } = setup()
    expect(await handlers.get(IPC.aiEmbed)!(mainEvent, [])).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    embed.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 'rate-limited' }))
    const failed = await handlers.get(IPC.aiEmbed)!(mainEvent, ['a'])
    expect(failed).toMatchObject({ ok: false, error: { code: 'rate-limited', message: 'quota' } })
  })
})
