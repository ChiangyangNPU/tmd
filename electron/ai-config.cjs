/**
 * AI 助手配置持久化（userData/ai-config.json）。
 *
 * 配置只存主进程：API Key 经 safeStorage 加密后落盘，渲染层永远拿到不到明文，
 * 只能通过 publicView() 得知「是否已保存」。文件随应用卸载清理。
 * 采用同步原子写（临时文件 + rename）：配置文件体量极小，且保存由用户显式触发，
 * 避免异步写链在退出路径上丢最后一次保存（与 shell-state.cjs 同构）。
 *
 * 依赖注入（app / safeStorage 由 main.cjs 传入）而非顶层 require('electron')：
 * 本模块可被单测直接 require。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs')

/**
 * 内置服务商预设：全部走 OpenAI 兼容协议（chat/completions、embeddings），
 * 因此只需要一套请求实现；预设仅提供默认 baseUrl 与模型名。
 * needsKey：云端服务商必须填 Key；Ollama 与自定义本地端点允许留空。
 * @type {Record<string, { label: string, baseUrl: string, model: string, needsKey: boolean }>}
 */
const AI_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsKey: true,
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    needsKey: false,
  },
}

/** 默认服务商：DeepSeek（国内访问稳定、成本低，且走标准 OpenAI 兼容协议） */
const DEFAULT_PROVIDER = 'deepseek'

/** 上下文发送范围默认值：只发用户显式选中的内容 */
const DEFAULT_CONTEXT = { selection: true, document: false, workspace: false }

/**
 * @typedef {object} AiContextScope
 * @property {boolean} selection 是否允许发送当前选区
 * @property {boolean} document  是否允许发送当前文档
 * @property {boolean} workspace 是否允许发送工作区检索结果
 */

/**
 * @typedef {object} AiConfig
 * @property {boolean} enabled 总开关（默认关闭）
 * @property {string} provider 服务商标识（AI_PROVIDERS 的键）
 * @property {string} baseUrl OpenAI 兼容根地址（不含 /chat/completions）
 * @property {string} model 模型名
 * @property {number} temperature 采样温度（0–2）
 * @property {boolean} streaming 是否使用流式响应
 * @property {AiContextScope} context 上下文发送范围
 * @property {string} embedModel 向量模型（工作区问答用，允许为空）
 * @property {string} apiKey 明文 Key（仅主进程内存中，绝不返回渲染层）
 */

/** 是否是普通对象（配置入参全部不可信） */
/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 把任意入参钳制为 0–2 的数字 */
/** @param {unknown} v @param {number} fallback @returns {number} */
function clampTemperature(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(2, Math.max(0, Math.round(n * 10) / 10))
}

/**
 * 校验并归一化 baseUrl：只接受 http/https 且无空白字符；尾部斜杠去掉。
 * 非法时回落到服务商预设（custom 允许空串，由用户自行填写）。
 * @param {unknown} value
 * @param {string} provider
 * @returns {string}
 */
function normalizeBaseUrl(value, provider) {
  const preset = AI_PROVIDERS[provider]
  /** @param {string} raw */
  const trim = (raw) => raw.trim().replace(/\/+$/, '')
  if (typeof value === 'string' && value.trim()) {
    const trimmed = trim(value)
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return trimmed
    } catch {
      // 非法 URL 走预设兜底
    }
  }
  return preset ? preset.baseUrl : ''
}

/**
 * 按白名单归一化配置字段（文件损坏 / 旧版本 / 恶意入参都走这里）。
 * @param {unknown} raw
 * @returns {Omit<AiConfig, 'apiKey'>}
 */
function sanitizeSettings(raw) {
  const r = isRecord(raw) ? raw : {}
  const provider =
    typeof r.provider === 'string' && AI_PROVIDERS[r.provider] ? r.provider : DEFAULT_PROVIDER
  const preset = AI_PROVIDERS[provider]
  const model =
    typeof r.model === 'string' && r.model.trim()
      ? r.model.trim().slice(0, 120)
      : preset
        ? preset.model
        : ''
  const context = isRecord(r.context) ? r.context : {}
  return {
    enabled: r.enabled === true,
    provider,
    baseUrl: normalizeBaseUrl(r.baseUrl, provider),
    model,
    temperature: clampTemperature(r.temperature, 0.7),
    streaming: r.streaming !== false,
    context: {
      selection: context.selection !== false,
      document: context.document === true,
      workspace: context.workspace === true,
    },
    embedModel: typeof r.embedModel === 'string' ? r.embedModel.trim().slice(0, 120) : '',
  }
}

/**
 * 创建 AI 配置服务。
 * @param {{
 *   app: import('electron').App,
 *   safeStorage?: import('electron').SafeStorage | null,
 * }} deps
 */
function createAiConfig({ app, safeStorage }) {
  /** 配置文件名（userData 私有目录，随卸载清理） */
  const configFile = path.join(app.getPath('userData'), 'ai-config.json')

  /**
   * 加密 Key：safeStorage 可用时写入密文；不可用（部分 Linux 桌面缺少
   * keyring）时降级为明文并带 plain 标记——功能可用性优先，文件仍是
   * 用户私有目录权限。
   * @param {string} plain
   * @returns {{ v: number, enc?: string, plain?: string }}
   */
  function encryptSecret(plain) {
    try {
      if (safeStorage?.isEncryptionAvailable?.()) {
        return { v: 1, enc: safeStorage.encryptString(plain).toString('base64') }
      }
    } catch {
      // 加密失败按降级处理
    }
    return { v: 1, plain }
  }

  /**
   * 解密 Key：密文解不开（换机器 / keyring 变更）时返回空串，
   * 用户需在设置面板重新填写。
   * @param {unknown} secret
   * @returns {string}
   */
  function decryptSecret(secret) {
    if (!isRecord(secret)) return ''
    if (typeof secret.enc === 'string' && secret.enc) {
      try {
        return safeStorage ? safeStorage.decryptString(Buffer.from(secret.enc, 'base64')) : ''
      } catch {
        return ''
      }
    }
    return typeof secret.plain === 'string' ? secret.plain : ''
  }

  /** 读取磁盘原始记录；文件缺失 / JSON 损坏时返回空对象 */
  /** @returns {Record<string, unknown>} */
  function readRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * 读取完整配置（含明文 Key，仅供主进程内部使用）。
   * @returns {AiConfig}
   */
  function read() {
    const raw = readRaw()
    return { ...sanitizeSettings(raw), apiKey: decryptSecret(raw.secret) }
  }

  /**
   * 写入配置（增量合并语义：patch 中缺省的字段保持原值）。
   * apiKey 仅在传入非空字符串时更新；clearApiKey === true 时清除；
   * 两者都不传则保留原 Key（渲染层界面上永远看不到明文，不能靠空串区分
   * 「未修改」与「清空」）。
   * @param {Record<string, unknown>} patch
   * @returns {ReturnType<typeof publicView>}
   */
  function save(patch) {
    const raw = readRaw()
    const current = sanitizeSettings(raw)
    const nextProvider =
      typeof patch.provider === 'string' && AI_PROVIDERS[patch.provider]
        ? patch.provider
        : current.provider
    /** @type {Record<string, unknown>} */
    const input = {
      ...current,
      ...patch,
      // 嵌套对象单独合并：只传 context.document 时不能把 selection 抹成默认值
      context: { ...current.context, ...(isRecord(patch.context) ? patch.context : {}) },
    }
    // 只切换服务商而没显式带地址/模型时，回落到新服务商的预设值，
    // 否则会沿用上一家的地址（界面会自动回填，API 调用方不一定）
    if (nextProvider !== current.provider) {
      const preset = AI_PROVIDERS[nextProvider]
      if (typeof patch.baseUrl !== 'string') input.baseUrl = preset.baseUrl
      if (typeof patch.model !== 'string') input.model = preset.model
    }
    const merged = sanitizeSettings(input)
    /** @type {Record<string, unknown>} */
    const next = { version: 1, ...merged }
    const rawKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
    if (rawKey) next.secret = encryptSecret(rawKey)
    else if (patch.clearApiKey === true) delete next.secret
    else if (raw.secret) next.secret = raw.secret

    try {
      const tmp = `${configFile}.tmp`
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
      fs.renameSync(tmp, configFile)
    } catch {
      // 写失败静默：配置只影响 AI 可用性，下次保存会重试
    }
    return publicView()
  }

  /**
   * 渲染层可见的配置视图：剔除明文 Key，仅暴露 hasApiKey 与 apiKeyLength
   * （长度供界面渲染等宽占位点，不含明文与后缀）。providers 一并下发，
   * 避免渲染层重复维护一份预设表。
   * @returns {{
   *   enabled: boolean,
   *   provider: string,
   *   baseUrl: string,
   *   model: string,
   *   temperature: number,
   *   streaming: boolean,
   *   context: AiContextScope,
   *   embedModel: string,
   *   hasApiKey: boolean,
   *   apiKeyLength: number,
   *   providers: Array<{ id: string, label: string, baseUrl: string, model: string, needsKey: boolean }>,
   * }}
   */
  function publicView() {
    const config = read()
    /** @type {Record<string, unknown>} */
    const view = {
      ...config,
      hasApiKey: !!config.apiKey,
      apiKeyLength: config.apiKey.length,
    }
    delete view.apiKey
    view.providers = Object.entries(AI_PROVIDERS).map(([id, preset]) => ({ id, ...preset }))
    return /** @type {ReturnType<typeof publicView>} */ (view)
  }

  /**
   * 组装一次请求所需的连接参数（含 Key），overrides 仅取非空字段。
   * 供 ai-client 使用；不接受来自渲染层的任意额外字段。
   * @param {unknown} [overrides]
   * @returns {{ provider: string, baseUrl: string, model: string, apiKey: string, temperature: number, streaming: boolean, needsKey: boolean, embedModel: string }}
   */
  function getClientConfig(overrides) {
    const base = read()
    const o = isRecord(overrides) ? overrides : {}
    const mergedProvider =
      typeof o.provider === 'string' && AI_PROVIDERS[o.provider] ? o.provider : base.provider
    const preset = AI_PROVIDERS[mergedProvider]
    const baseUrl =
      typeof o.baseUrl === 'string' && o.baseUrl.trim()
        ? normalizeBaseUrl(o.baseUrl, mergedProvider)
        : mergedProvider === base.provider
          ? base.baseUrl
          : normalizeBaseUrl('', mergedProvider)
    const model =
      typeof o.model === 'string' && o.model.trim()
        ? o.model.trim().slice(0, 120)
        : mergedProvider === base.provider
          ? base.model
          : preset
            ? preset.model
            : ''
    const apiKey = typeof o.apiKey === 'string' && o.apiKey.trim() ? o.apiKey.trim() : base.apiKey
    const temperature =
      o.temperature != null ? clampTemperature(o.temperature, base.temperature) : base.temperature
    return {
      provider: mergedProvider,
      baseUrl,
      model,
      apiKey,
      temperature,
      streaming: o.streaming === false ? false : base.streaming,
      needsKey: preset ? preset.needsKey : false,
      embedModel:
        typeof o.embedModel === 'string' && o.embedModel.trim()
          ? o.embedModel.trim().slice(0, 120)
          : base.embedModel,
    }
  }

  return { read, save, publicView, getClientConfig }
}

module.exports = { createAiConfig, AI_PROVIDERS, DEFAULT_PROVIDER, DEFAULT_CONTEXT }
