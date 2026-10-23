/**
 * AI 请求客户端（主进程）。
 *
 * 支持全部「OpenAI 兼容」协议的服务商（OpenAI / DeepSeek / Moonshot / 智谱 /
 * Ollama / 用户自定义端点），因此只需要一套请求实现：POST {baseUrl}/chat/completions
 * （对话）与 POST {baseUrl}/embeddings（向量嵌入，工作区检索用）。
 *
 * 职责：
 * - 流式 SSE 解析（按行切分，容忍网络分块把一行拆到两个 chunk 的边界）
 * - 按 requestId 管理 AbortController（渲染层可随时中止）
 * - 空闲超时（默认 60s 无新数据即中止）与 HTTP 错误码归一化
 * - 连通性测试（非流式，短提示词）
 * - 向量嵌入（非流式，按输入顺序返回，响应结构逐条校验）
 *
 * 网络只发生在主进程：渲染层拿不到 API Key，CSP 的 connect-src 也不需要放开。
 *
 * @author chiangyang
 */

/** 流式请求的空闲超时：60s 内没有任何数据即视为超时（思考型模型首字可能较慢） */
const IDLE_TIMEOUT_MS = 60_000

/** 连通性测试的整体超时 */
const TEST_TIMEOUT_MS = 20_000

/** 向量嵌入的整体超时（非流式一次性请求，无增量可续） */
const EMBED_TIMEOUT_MS = 60_000

/**
 * @typedef {object} ChatConfig
 * @property {string} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 * @property {number} temperature
 * @property {boolean} streaming
 * @property {boolean} needsKey
 * @property {string} embedModel 向量模型（工作区检索用，空串表示未配置）
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} role
 * @property {string} content
 */

/**
 * 客户端向调用方推送的流式事件（ipc 层再附加 requestId 后转发渲染层）。
 * @typedef {{ type: 'delta', text: string }
 *   | { type: 'reasoning', text: string }
 *   | { type: 'done' }} StreamEvent
 */

/** 带错误码的 AI 错误：code 供渲染层做文案映射，message 保留上游原文 */
class AiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'AiError'
    this.code = code
  }
}

/**
 * 增量 SSE 解析器。
 *
 * 输入可能以任意边界切分（一个 JSON 被拆到两个 chunk），因此内部维护行缓冲：
 * 只在遇到 \n 时消费整行。兼容 CRLF，忽略事件行 / 空行 / 无法解析的保活数据。
 * @param {(event: { type: 'data', data: unknown } | { type: 'done' }) => void} onEvent
 */
function createSseParser(onEvent) {
  let buffer = ''

  /** @param {string} line */
  function consumeLine(line) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload) return
    if (payload === '[DONE]') {
      onEvent({ type: 'done' })
      return
    }
    try {
      onEvent({ type: 'data', data: JSON.parse(payload) })
    } catch {
      // 非 JSON 的 data 行（部分网关的保活注释）直接忽略
    }
  }

  /** @param {string} chunk */
  function push(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      consumeLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }

  /** 流结束时处理没有换行符结尾的最后一行 */
  function flush() {
    if (buffer) consumeLine(buffer)
    buffer = ''
  }

  return { push, flush }
}

/**
 * HTTP 状态码 → 内部错误码。
 * @param {number} status
 * @returns {string}
 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not-found'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  return 'bad-request'
}

/**
 * 从失败响应中提取错误信息（各服务商结构不一，尽量给出可读文本）。
 * @param {{ text: () => Promise<string> }} res
 * @returns {Promise<string>}
 */
async function readErrorMessage(res) {
  try {
    const text = await res.text()
    if (!text) return ''
    try {
      const data = JSON.parse(text)
      return data?.error?.message || data?.message || text.slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return ''
  }
}

/**
 * 创建 AI 客户端。
 * @param {{
 *   getConfig: (overrides?: unknown) => ChatConfig,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
function createAiClient({ getConfig, fetchImpl = globalThis.fetch }) {
  /** @type {Map<string, AbortController>} */
  const controllers = new Map()

  /**
   * 校验连接参数是否足以发起请求。
   * @param {ChatConfig} cfg
   * @param {boolean} requireKey
   * @throws {AiError}
   */
  function assertConfig(cfg, requireKey) {
    if (!cfg.baseUrl) throw new AiError('not-configured', 'API base URL is not configured')
    if (!cfg.model) throw new AiError('not-configured', 'Model is not configured')
    if (requireKey && cfg.needsKey && !cfg.apiKey) {
      throw new AiError('no-api-key', 'API key is not configured')
    }
  }

  /**
   * 组装请求地址与请求头。
   * @param {ChatConfig} cfg
   * @returns {{ url: string, headers: Record<string, string> }}
   */
  function endpoint(cfg) {
    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    return { url: `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, headers }
  }

  /**
   * 发起一次对话。成功时返回完整文本；失败抛 AiError。
   * 流式事件（delta / reasoning）经 onEvent 实时回调。
   * @param {{
   *   requestId: string,
   *   messages: ChatMessage[],
   *   onEvent: (event: StreamEvent) => void,
   * }} params
   * @returns {Promise<{ content: string }>}
   */
  async function chat({ requestId, messages, onEvent }) {
    const cfg = getConfig()
    assertConfig(cfg, true)
    const { url, headers } = endpoint(cfg)

    const controller = new AbortController()
    controllers.set(requestId, controller)
    /** 是否由空闲超时触发（用于区分用户主动取消与超时） */
    let timedOut = false
    /** @type {ReturnType<typeof setTimeout>} */
    let timer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS)
    function onIdleTimeout() {
      timedOut = true
      controller.abort()
    }
    function resetTimer() {
      clearTimeout(timer)
      timer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS)
    }

    try {
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: cfg.temperature,
            stream: cfg.streaming,
          }),
          signal: controller.signal,
        })
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AiError(
            timedOut ? 'timeout' : 'cancelled',
            timedOut ? 'Request timed out' : 'Request cancelled',
          )
        }
        throw new AiError('network', err instanceof Error ? err.message : String(err))
      }

      if (!res.ok) {
        const message = await readErrorMessage(res)
        throw new AiError(codeForStatus(res.status), message || `HTTP ${res.status}`)
      }
      resetTimer()

      const contentType = res.headers.get('content-type') || ''
      // 非流式响应（stream:false 或服务商忽略 stream）：一次性读取 JSON
      if (!contentType.includes('text/event-stream') || !res.body) {
        let data
        try {
          data = await res.json()
        } catch (err) {
          // 响应体下载中被中止（空闲超时 / 用户取消）或本身非法 JSON：
          // 归一化为带码错误，避免渲染层拿到 unknown + 裸异常文案
          if (controller.signal.aborted) {
            throw new AiError(
              timedOut ? 'timeout' : 'cancelled',
              timedOut ? 'Request timed out' : 'Request cancelled',
            )
          }
          throw new AiError('bad-response', err instanceof Error ? err.message : String(err))
        }
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          throw new AiError('bad-response', 'Missing message content in response')
        }
        onEvent({ type: 'delta', text: content })
        onEvent({ type: 'done' })
        return { content }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let content = ''
      /** @type {AiError | null} */
      let streamError = null
      const parser = createSseParser((event) => {
        if (event.type === 'done') {
          onEvent({ type: 'done' })
          return
        }
        // 逐字段做运行时校验：上游网关返回结构不完全可信
        const data = /** @type {any} */ (event.data)
        if (data && typeof data === 'object' && data.error) {
          const errMessage = data.error
          streamError = new AiError(
            'server-error',
            typeof errMessage === 'object' && typeof errMessage.message === 'string'
              ? errMessage.message
              : 'Upstream stream error',
          )
          return
        }
        const delta = data?.choices?.[0]?.delta
        if (delta && typeof delta === 'object') {
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            onEvent({ type: 'reasoning', text: delta.reasoning_content })
          }
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content
            onEvent({ type: 'delta', text: delta.content })
            resetTimer()
          }
        }
      })

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          parser.push(decoder.decode(value, { stream: true }))
          if (streamError) break
        }
        parser.flush()
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AiError(
            timedOut ? 'timeout' : 'cancelled',
            timedOut ? 'Request timed out' : 'Request cancelled',
          )
        }
        throw new AiError('network', err instanceof Error ? err.message : String(err))
      }
      if (streamError) throw streamError
      return { content }
    } finally {
      clearTimeout(timer)
      controllers.delete(requestId)
    }
  }

  /**
   * 连通性测试：发一条极短的非流式请求，返回结果而不是抛错（设置面板直接展示）。
   * overrides 允许测试尚未保存的表单值。
   * @param {{ overrides?: unknown }} [params]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, latencyMs: number }>}
   */
  async function test({ overrides } = {}) {
    const started = Date.now()
    const cfg = getConfig(overrides)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      assertConfig(cfg, true)
      const { url, headers } = endpoint(cfg)
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          stream: false,
        }),
        signal: controller.signal,
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        return {
          ok: false,
          code: codeForStatus(res.status),
          message: (await readErrorMessage(res)) || `HTTP ${res.status}`,
          latencyMs,
        }
      }
      // 读完响应体，确保连接可正常释放
      await res.text()
      return { ok: true, latencyMs }
    } catch (err) {
      const latencyMs = Date.now() - started
      if (err instanceof AiError) {
        return { ok: false, code: err.code, message: err.message, latencyMs }
      }
      if (controller.signal.aborted) {
        return { ok: false, code: 'timeout', message: 'Request timed out', latencyMs }
      }
      return {
        ok: false,
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
        latencyMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 向量嵌入（工作区检索 / RAG 用）：非流式一次性请求，按输入顺序返回向量。
   * 条数与体积上限由 ipc 层校验，这里只做连接参数与响应结构校验。
   * @param {{ texts: string[] }} params
   * @returns {Promise<{ vectors: number[][] }>}
   */
  async function embed({ texts }) {
    const cfg = getConfig()
    if (!cfg.baseUrl) throw new AiError('not-configured', 'API base URL is not configured')
    if (!cfg.embedModel) throw new AiError('not-configured', 'Embedding model is not configured')
    if (cfg.needsKey && !cfg.apiKey) {
      throw new AiError('no-api-key', 'API key is not configured')
    }
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
    try {
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: cfg.embedModel, input: texts }),
          signal: controller.signal,
        })
      } catch (err) {
        if (controller.signal.aborted) throw new AiError('timeout', 'Request timed out')
        throw new AiError('network', err instanceof Error ? err.message : String(err))
      }
      if (!res.ok) {
        const message = await readErrorMessage(res)
        throw new AiError(codeForStatus(res.status), message || `HTTP ${res.status}`)
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        if (controller.signal.aborted) throw new AiError('timeout', 'Request timed out')
        throw new AiError('bad-response', err instanceof Error ? err.message : String(err))
      }
      // 各服务商以 index 标注输入对应关系；逐条做运行时校验（上游结构不可信）
      const rows = Array.isArray(data?.data) ? data.data : null
      if (!rows || rows.length !== texts.length) {
        throw new AiError('bad-response', 'Unexpected embeddings response shape')
      }
      const vectors = new Array(texts.length)
      for (const row of rows) {
        const vec = row && typeof row === 'object' ? row.embedding : null
        if (
          !Array.isArray(vec) ||
          !vec.length ||
          !vec.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
          throw new AiError('bad-response', 'Invalid embedding vector')
        }
        const index = typeof row.index === 'number' ? row.index : -1
        if (!Number.isInteger(index) || index < 0 || index >= texts.length || vectors[index]) {
          throw new AiError('bad-response', 'Invalid embedding index')
        }
        vectors[index] = vec
      }
      if (vectors.some((v) => !v)) throw new AiError('bad-response', 'Missing embedding vector')
      return { vectors }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 中止指定请求；请求不存在时返回 false。
   * @param {string} requestId
   * @returns {boolean}
   */
  function abort(requestId) {
    const controller = controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  return { chat, test, embed, abort }
}

module.exports = { createAiClient, createSseParser, AiError }
