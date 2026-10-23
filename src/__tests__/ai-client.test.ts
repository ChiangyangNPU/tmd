import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

/**
 * ai-client.cjs：SSE 边界解析、流式增量拼装、错误码归一化、中止。
 * 网络层用假 fetch 注入，不触达真实服务商。
 */

interface ChatConfig {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  temperature: number
  streaming: boolean
  needsKey: boolean
}

interface StreamEvent {
  type: 'delta' | 'reasoning' | 'done'
  text?: string
}

interface AiClient {
  chat(params: {
    requestId: string
    messages: { role: string; content: string }[]
    onEvent: (event: StreamEvent) => void
  }): Promise<{ content: string }>
  test(params?: { overrides?: unknown }): Promise<{
    ok: boolean
    code?: string
    message?: string
    latencyMs: number
  }>
  embed(params: { texts: string[] }): Promise<{ vectors: number[][] }>
  abort(requestId: string): boolean
}

const require = createRequire(import.meta.url)
const { createAiClient, createSseParser } = require('../../electron/ai-client.cjs') as {
  createAiClient: (deps: {
    getConfig: (overrides?: unknown) => ChatConfig
    fetchImpl?: typeof fetch
  }) => AiClient
  createSseParser: (
    onEvent: (event: { type: 'data'; data: unknown } | { type: 'done' }) => void,
  ) => { push(chunk: string): void; flush(): void }
}

const config: ChatConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.test/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  temperature: 0.7,
  streaming: true,
  needsKey: true,
}

/** embed 配置：ChatConfig 加上向量模型字段 */
const embedConfig: ChatConfig & { embedModel: string } = { ...config, embedModel: 'text-embedding-test' }

/** 构造 embeddings JSON 响应 */
function embeddingsResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data,
  } as unknown as Response
}

/** 构造 SSE 响应（chunks 模拟网络分块，可在任意位置切断一行） */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  } as unknown as Response
}

/** 构造失败响应（错误体为服务商 JSON） */
function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response
}

describe('SSE 增量解析', () => {
  it('一行被拆到两个 chunk 时仍能完整解析', () => {
    const events: unknown[] = []
    const parser = createSseParser((event) => events.push(event))
    parser.push('data: {"choices":[{"delta":{"content":"he')
    parser.push('llo"}}]}\n\n')
    parser.flush()
    expect(events).toEqual([{ type: 'data', data: { choices: [{ delta: { content: 'hello' } }] } }])
  })

  it('[DONE] 触发 done，兼容 CRLF，忽略无法解析的保活数据', () => {
    const events: unknown[] = []
    const parser = createSseParser((event) => events.push(event))
    parser.push(': keepalive\r\n')
    parser.push('data: not-json\r\n')
    parser.push('data: [DONE]\r\n')
    parser.flush()
    expect(events).toEqual([{ type: 'done' }])
  })

  it('流结束时无换行符的最后一行也会被消费', () => {
    const events: unknown[] = []
    const parser = createSseParser((event) => events.push(event))
    parser.push('data: [DONE]')
    parser.flush()
    expect(events).toEqual([{ type: 'done' }])
  })
})

describe('对话流式请求', () => {
  it('拼装增量文本、按序回调 delta 与 done', async () => {
    const deltas: string[] = []
    const events: string[] = []
    let authHeader = ''
    let body: Record<string, unknown> = {}
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        authHeader = String((init?.headers as Record<string, string>).Authorization)
        body = JSON.parse(String(init?.body))
        void url
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ])
      }) as typeof fetch,
    })

    const result = await client.chat({
      requestId: 'r1',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (event) => {
        events.push(event.type)
        if (event.type === 'delta' && event.text) deltas.push(event.text)
      },
    })

    expect(result.content).toBe('你好')
    expect(deltas).toEqual(['你', '好'])
    expect(events).toEqual(['delta', 'delta', 'done'])
    expect(authHeader).toBe('Bearer sk-test')
    expect(body).toMatchObject({ model: 'deepseek-chat', stream: true, temperature: 0.7 })
  })

  it('reasoning_content 作为独立事件推送，不混入正文', async () => {
    const reasoning: string[] = []
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
          'data: [DONE]\n\n',
        ])) as typeof fetch,
    })
    const result = await client.chat({
      requestId: 'r2',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (event) => {
        if (event.type === 'reasoning' && event.text) reasoning.push(event.text)
      },
    })
    expect(reasoning).toEqual(['思考'])
    expect(result.content).toBe('答案')
  })

  it('服务商忽略 stream 参数时按非流式 JSON 处理', async () => {
    const events: string[] = []
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: null,
          json: async () => ({ choices: [{ message: { content: '完整回答' } }] }),
        }) as unknown as Response) as typeof fetch,
    })
    const result = await client.chat({
      requestId: 'r3',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (event) => events.push(event.type),
    })
    expect(result.content).toBe('完整回答')
    expect(events).toEqual(['delta', 'done'])
  })

  it('非流式响应体被中止时映射为 cancelled（而非裸 AbortError）', async () => {
    let signal: AbortSignal | undefined
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: null,
          json: () =>
            new Promise((_resolve, reject) => {
              if (signal?.aborted) {
                const err = new Error('aborted')
                err.name = 'AbortError'
                reject(err)
                return
              }
              signal?.addEventListener('abort', () => {
                const err = new Error('aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }),
        } as unknown as Response
      }) as typeof fetch,
    })
    const promise = client.chat({
      requestId: 'r9',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: () => {},
    })
    client.abort('r9')
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('非流式响应体非法 JSON 映射为 bad-response', async () => {
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: null,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON')
          },
        }) as unknown as Response) as typeof fetch,
    })
    await expect(
      client.chat({
        requestId: 'r10',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'bad-response' })
  })

  it('401 映射为 unauthorized 并带上游错误信息', async () => {
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () =>
        errorResponse(401, '{"error":{"message":"bad key"}}')) as typeof fetch,
    })
    await expect(
      client.chat({
        requestId: 'r4',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: 'bad key' })
  })

  it('429 / 5xx 分别映射为 rate-limited / server-error', async () => {
    const make = (status: number) =>
      createAiClient({
        getConfig: () => config,
        fetchImpl: (async () => errorResponse(status, 'upstream down')) as typeof fetch,
      })
    await expect(
      make(429).chat({
        requestId: 'r5',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'rate-limited' })
    await expect(
      make(503).chat({
        requestId: 'r6',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'server-error' })
  })

  it('缺少 API Key 时在发请求前即报 no-api-key', async () => {
    let called = false
    const client = createAiClient({
      getConfig: () => ({ ...config, apiKey: '' }),
      fetchImpl: (async () => {
        called = true
        return sseResponse([])
      }) as typeof fetch,
    })
    await expect(
      client.chat({
        requestId: 'r7',
        messages: [{ role: 'user', content: 'hi' }],
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'no-api-key' })
    expect(called).toBe(false)
  })

  it('abort 中止在途请求并映射为 cancelled', async () => {
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })) as typeof fetch,
    })
    const promise = client.chat({
      requestId: 'r8',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: () => {},
    })
    expect(client.abort('r8')).toBe(true)
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    expect(client.abort('r8')).toBe(false)
  })
})

describe('向量嵌入', () => {
  it('按 index 恢复输入顺序，请求体带向量模型', async () => {
    let body: Record<string, unknown> = {}
    const client = createAiClient({
      getConfig: () => embedConfig,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        // 上游乱序返回，应按 index 归位
        return embeddingsResponse({
          data: [
            { index: 1, embedding: [0.3, 0.4] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        })
      }) as typeof fetch,
    })
    const { vectors } = await client.embed({ texts: ['一', '二'] })
    expect(body).toMatchObject({ model: 'text-embedding-test', input: ['一', '二'] })
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  it('未配置向量模型时发请求前即报 not-configured', async () => {
    let called = false
    const client = createAiClient({
      getConfig: () => ({ ...config, embedModel: '' }),
      fetchImpl: (async () => {
        called = true
        return embeddingsResponse({ data: [] })
      }) as typeof fetch,
    })
    await expect(client.embed({ texts: ['x'] })).rejects.toMatchObject({ code: 'not-configured' })
    expect(called).toBe(false)
  })

  it('HTTP 错误归一化为错误码', async () => {
    const client = createAiClient({
      getConfig: () => embedConfig,
      fetchImpl: (async () => errorResponse(401, '{"error":{"message":"bad key"}}')) as typeof fetch,
    })
    await expect(client.embed({ texts: ['x'] })).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'bad key',
    })
  })

  it('响应结构异常（缺 data / 数量不符 / 非法向量 / 非法 index）都报 bad-response', async () => {
    const make = (data: unknown) =>
      createAiClient({
        getConfig: () => embedConfig,
        fetchImpl: (async () => embeddingsResponse(data)) as typeof fetch,
      })
    await expect(make({}).embed({ texts: ['x'] })).rejects.toMatchObject({ code: 'bad-response' })
    await expect(make({ data: [] }).embed({ texts: ['x'] })).rejects.toMatchObject({
      code: 'bad-response',
    })
    await expect(
      make({ data: [{ index: 0, embedding: ['bad'] }] }).embed({ texts: ['x'] }),
    ).rejects.toMatchObject({ code: 'bad-response' })
    await expect(make({ data: [{ index: 5, embedding: [1] }] }).embed({ texts: ['x'] })).rejects.toMatchObject(
      { code: 'bad-response' },
    )
    await expect(make({ data: [{ embedding: [1] }] }).embed({ texts: ['x'] })).rejects.toMatchObject(
      { code: 'bad-response' },
    )
  })
})

describe('连通性测试', () => {
  it('成功返回耗时', async () => {
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '{}',
        }) as unknown as Response) as typeof fetch,
    })
    const result = await client.test()
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('失败返回结构化错误而不抛异常', async () => {
    const client = createAiClient({
      getConfig: () => config,
      fetchImpl: (async () => errorResponse(404, 'no model')) as typeof fetch,
    })
    const result = await client.test()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-found')
    expect(result.message).toBe('no model')
  })

  it('overrides 传给配置解析（用于测试未保存的表单值）', async () => {
    let overrides: unknown = null
    const client = createAiClient({
      getConfig: (o) => {
        overrides = o ?? null
        return config
      },
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => '{}',
        }) as unknown as Response) as typeof fetch,
    })
    await client.test({ overrides: { model: 'form-model' } })
    expect(overrides).toEqual({ model: 'form-model' })
  })
})
