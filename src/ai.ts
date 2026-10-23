/**
 * AI 助手渲染层客户端。
 *
 * 只做三件事：转发配置读写 / 连通性测试；把一次对话封装成带 requestId 的
 * 会话（增量事件按 requestId 分发）；提供错误码到界面文案的映射。
 *
 * 网络请求与 API Key 全部留在主进程：本模块不接触 Key，也不直接 fetch——
 * CSP 的 connect-src 因此无需放开，浏览器模式下整块功能自动禁用。
 *
 * @author chiangyang
 */
import type {
  AiChatMessage,
  AiChatStart,
  AiConfigPatch,
  AiConfigView,
  AiStreamEvent,
  AiTestResult,
} from './native'
import { native } from './native'
import { t } from './i18n'

/** AI 功能是否可用（浏览器环境没有壳层 API，整块功能隐藏） */
export function isAiAvailable(): boolean {
  return !!native?.getAiConfig
}

/** 缓存的服务商启用状态：菜单 / 命令面板需同步判断，不能每次读磁盘配置 */
let aiEnabled = false

/**
 * AI 是否已启用（同步取值）。
 * 由 refreshAiEnabled 在启动与设置保存后刷新；未启用时不暴露任何入口。
 */
export function isAiEnabled(): boolean {
  return aiEnabled
}

/**
 * 重新读取配置并刷新启用状态。
 * @returns 最新启用状态（不可用环境恒为 false）
 */
export async function refreshAiEnabled(): Promise<boolean> {
  const view = isAiAvailable() ? await fetchAiConfig() : null
  aiEnabled = view?.enabled === true
  return aiEnabled
}

/** 对话增量事件回调 */
export interface AiChatHandlers {
  /** 正文增量（按到达顺序拼接即为完整回答） */
  onDelta(text: string): void
  /** 思考过程增量（部分推理模型会先输出 reasoning_content） */
  onReasoning?(text: string): void
  /** 正常结束（收到 [DONE] 或非流式响应读完） */
  onDone(): void
  /** 失败或被中止（code 见 ai-error.* 文案） */
  onError?(error: { code: string; message: string }): void
}

/** 一次对话的句柄：requestId 用于中止，cancel 幂等 */
export interface AiChatSession {
  requestId: string
  cancel(): void
}

/** 在途请求表：requestId → 回调（完成/失败后立即删除，避免泄漏） */
const pending = new Map<string, AiChatHandlers>()
/** 流式事件订阅是否已挂载（preload 只提供一次性 on，重复挂载会重复分发） */
let wired = false

/** 生成请求 id：优先用 crypto.randomUUID（Electron 渲染进程支持） */
function newRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 挂载流式事件订阅（只挂一次） */
function wireStream(): void {
  if (wired || !native) return
  wired = true
  native.onAiStream((event: AiStreamEvent) => {
    const handlers = pending.get(event.requestId)
    if (!handlers) return
    switch (event.type) {
      case 'delta':
        handlers.onDelta(event.text)
        break
      case 'reasoning':
        handlers.onReasoning?.(event.text)
        break
      case 'done':
        pending.delete(event.requestId)
        handlers.onDone()
        break
      case 'error':
        pending.delete(event.requestId)
        handlers.onError?.({ code: event.code, message: event.message })
        break
    }
  })
}

/** 读取 AI 配置视图（不含明文 Key）；浏览器环境或调用失败返回 null */
export async function fetchAiConfig(): Promise<AiConfigView | null> {
  if (!native?.getAiConfig) return null
  try {
    return await native.getAiConfig()
  } catch {
    return null
  }
}

/** 保存配置增量并返回最新视图；失败返回 null（调用方保留表单状态） */
export async function saveAiConfig(patch: AiConfigPatch): Promise<AiConfigView | null> {
  if (!native?.saveAiConfig) return null
  try {
    return await native.saveAiConfig(patch)
  } catch {
    return null
  }
}

/** 连通性测试：overrides 为尚未保存的表单值 */
export async function testAiConnection(overrides?: Partial<AiConfigPatch>): Promise<AiTestResult> {
  if (!native?.testAiConnection) {
    return { ok: false, code: 'unavailable', message: t('ai.unavailable'), latencyMs: 0 }
  }
  try {
    return await native.testAiConnection(overrides)
  } catch {
    return { ok: false, code: 'network', message: t('ai.error.network'), latencyMs: 0 }
  }
}

/**
 * 发起一次流式对话。
 *
 * 返回的句柄立即可用（requestId 已生成）；真正的启动是异步的，若主进程拒绝
 * （未启用 / 参数非法），会经 onError 回调给出结构化错误。
 * @param messages 完整消息列表（含 system 提示词）
 * @param handlers 增量回调
 */
export function chatAi(messages: AiChatMessage[], handlers: AiChatHandlers): AiChatSession {
  const requestId = newRequestId()
  wireStream()
  pending.set(requestId, handlers)

  const fail = (code: string, message: string) => {
    pending.delete(requestId)
    handlers.onError?.({ code, message })
  }

  if (!native?.chatAi) {
    fail('unavailable', t('ai.unavailable'))
    return { requestId, cancel: () => {} }
  }

  void native
    .chatAi(requestId, messages)
    .then((result: AiChatStart) => {
      if (!result.ok) {
        fail(result.error?.code ?? 'unknown', result.error?.message ?? t('ai.error.unknown'))
      }
    })
    .catch(() => fail('unknown', t('ai.error.unknown')))

  return {
    requestId,
    cancel: () => {
      // 中止后等主进程回推 error(cancelled) 再清理；若请求已结束则直接清理
      void native
        ?.abortAi(requestId)
        .then((hit: boolean) => {
          if (!hit) pending.delete(requestId)
        })
        .catch(() => pending.delete(requestId))
    },
  }
}

/**
 * 错误码 → 界面文案：语言包缺失该码时回落到上游 message，再回落到通用文案。
 * @param code 主进程返回的错误码（如 unauthorized / timeout）
 * @param fallback 上游原始错误信息
 */
export function aiErrorMessage(code?: string, fallback?: string): string {
  if (code) {
    const key = `ai.error.${code}`
    const text = t(key)
    if (text !== key) return text
  }
  return fallback || t('ai.error.unknown')
}
