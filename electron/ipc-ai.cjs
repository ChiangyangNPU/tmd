/**
 * AI 助手 IPC（配置读写 / 连通性测试 / 流式对话 / 中止）。
 *
 * 安全边界：
 * - 全部通道都校验调用方为主窗口（AI 配置含 Key 加密落盘路径，对话属于网络外发）
 * - 渲染层永远拿不到明文 Key，只能得到 hasApiKey
 * - messages 由渲染层提供，主进程做角色白名单与长度上限校验后才发往网络
 *
 * 对话采用「invoke 立即返回 + 事件流推送」：长响应不阻塞 invoke，渲染层用
 * requestId 关联增量事件；用户可随时经 aiAbort 中止。
 *
 * @author chiangyang
 */
const state = require('./app-state.cjs')

/** 单条消息内容上限（字符）：防止把超大文档整篇塞进请求 */
const MAX_MESSAGE_CHARS = 100_000

/** 单次请求全部消息合计上限（字符） */
const MAX_TOTAL_CHARS = 400_000

/** 单次请求最多消息条数 */
const MAX_MESSAGES = 100

/** 单条嵌入文本上限（字符） */
const MAX_EMBED_TEXT_CHARS = 8_000

/** 单次嵌入合计上限（字符） */
const MAX_EMBED_TOTAL_CHARS = 100_000

/** 单次嵌入条数上限 */
const MAX_EMBED_TEXTS = 64

/** 合法角色：只允许对话三方角色，避免向上游透传任意字段 */
const ROLES = new Set(['system', 'user', 'assistant'])

/** 是否是普通对象 */
/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 校验并裁剪对话消息；非法入参抛错（错误文案由渲染层兜底展示）。
 * @param {unknown} raw
 * @returns {Array<{ role: string, content: string }>}
 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invalid messages')
  if (raw.length > MAX_MESSAGES) throw new Error('too many messages')
  let total = 0
  /** @type {Array<{ role: string, content: string }>} */
  const result = []
  for (const item of raw) {
    if (!isRecord(item)) throw new Error('invalid message')
    const role = item.role
    const content = item.content
    if (typeof role !== 'string' || !ROLES.has(role)) throw new Error('invalid role')
    if (typeof content !== 'string' || !content) throw new Error('invalid content')
    if (content.length > MAX_MESSAGE_CHARS) throw new Error('message too large')
    total += content.length
    if (total > MAX_TOTAL_CHARS) throw new Error('request too large')
    result.push({ role, content })
  }
  return result
}

/**
 * 校验嵌入文本列表；非法入参抛错。
 * @param {unknown} raw
 * @returns {string[]}
 */
function sanitizeTexts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invalid texts')
  if (raw.length > MAX_EMBED_TEXTS) throw new Error('too many texts')
  let total = 0
  /** @type {string[]} */
  const result = []
  for (const item of raw) {
    if (typeof item !== 'string' || !item) throw new Error('invalid text')
    if (item.length > MAX_EMBED_TEXT_CHARS) throw new Error('text too large')
    total += item.length
    if (total > MAX_EMBED_TOTAL_CHARS) throw new Error('request too large')
    result.push(item)
  }
  return result
}

/**
 * 注册 AI 相关 IPC。
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   IPC: import('../src/native.ts').IpcChannels,
 *   aiConfig: ReturnType<typeof import('./ai-config.cjs').createAiConfig>,
 *   aiClient: ReturnType<typeof import('./ai-client.cjs').createAiClient>,
 *   sendToRenderer: (channel: string, payload: unknown) => void,
 * }} deps
 */
function registerAiIpc({ ipcMain, IPC, aiConfig, aiClient, sendToRenderer }) {
  /** 读取配置视图（不含明文 Key） */
  ipcMain.handle(IPC.aiGetConfig, (event) => {
    state.assertMainWindow(event)
    return aiConfig.publicView()
  })

  /** 保存配置增量并回传最新视图 */
  ipcMain.handle(IPC.aiSaveConfig, (event, patch) => {
    state.assertMainWindow(event)
    if (!isRecord(patch)) throw new Error('invalid config')
    return aiConfig.save(patch)
  })

  /** 连通性测试：允许传入尚未保存的表单值 */
  ipcMain.handle(IPC.aiTest, (event, overrides) => {
    state.assertMainWindow(event)
    return aiClient.test({ overrides: isRecord(overrides) ? overrides : {} })
  })

  /**
   * 发起对话：立即返回 requestId，后续增量经 aiStream 推送。
   * 禁用状态 / 参数非法时返回结构化错误，不抛异常（渲染层统一处理）。
   */
  ipcMain.handle(IPC.aiChat, (event, request) => {
    state.assertMainWindow(event)
    const config = aiConfig.read()
    if (!config.enabled) {
      return {
        ok: false,
        error: { code: 'disabled', message: 'AI assistant is disabled' },
      }
    }
    if (!isRecord(request) || typeof request.requestId !== 'string' || !request.requestId) {
      return { ok: false, error: { code: 'bad-request', message: 'Invalid request id' } }
    }
    const requestId = request.requestId.slice(0, 120)
    /** @type {Array<{ role: string, content: string }>} */
    let messages
    try {
      messages = sanitizeMessages(request.messages)
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: err instanceof Error ? err.message : 'Invalid messages',
        },
      }
    }

    // 异步执行流式请求：结果与异常都通过事件流回到渲染层
    void aiClient
      .chat({
        requestId,
        messages,
        onEvent: (payload) => sendToRenderer(IPC.aiStream, { requestId, ...payload }),
      })
      .catch((err) => {
        sendToRenderer(IPC.aiStream, {
          requestId,
          type: 'error',
          code: err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        })
      })
    return { ok: true, requestId }
  })

  /** 中止流式请求：返回是否命中在途请求 */
  ipcMain.handle(IPC.aiAbort, (event, requestId) => {
    state.assertMainWindow(event)
    if (typeof requestId !== 'string' || !requestId) return false
    return aiClient.abort(requestId)
  })

  /**
   * 向量嵌入（工作区检索用）：结构化结果返回（渲染层据此回退关键词检索）。
   * 入参校验同 aiChat——文本列表有数量与体积上限，且需 AI 已启用。
   */
  ipcMain.handle(IPC.aiEmbed, async (event, texts) => {
    state.assertMainWindow(event)
    const config = aiConfig.read()
    if (!config.enabled) {
      return { ok: false, error: { code: 'disabled', message: 'AI assistant is disabled' } }
    }
    /** @type {string[]} */
    let sanitized
    try {
      sanitized = sanitizeTexts(texts)
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: err instanceof Error ? err.message : 'Invalid texts',
        },
      }
    }
    try {
      const { vectors } = await aiClient.embed({ texts: sanitized })
      return { ok: true, vectors }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  })
}

module.exports = {
  registerAiIpc,
  sanitizeMessages,
  sanitizeTexts,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_EMBED_TEXT_CHARS,
}
