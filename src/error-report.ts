/**
 * 渲染层全局错误捕获。
 *
 * 职责：监听 window 的 error / unhandledrejection，归一化为 RendererErrorInfo
 * 后经 native API 上报主进程（主进程白名单校验并写入 ~/.tmd/logs 的 JSONL）。
 * 本模块不做任何 UI 反馈（避免打扰），也不调用 console——仅留痕。
 *
 * 安全与隐私：
 * - 只提取 message/stack/代码位置（文件名、行列号），不触碰文档内容
 * - 仅 Electron 环境安装（无 tmdAPI 时静默降级，与其余 native 能力一致）
 * - 安装幂等（HMR / 重复调用不会重复注册）
 *
 * @author chiangyang
 */
import { native } from './native'

/** 上报给主进程的错误信息（字段集与 logger.cjs normalizeRendererReport 对齐） */
export interface RendererErrorInfo {
  /** 错误消息（必填，空消息丢弃） */
  message: string
  /** 调用栈（若有） */
  stack?: string
  /** 源文件 URL（仅 window error 事件提供） */
  filename?: string
  /** 行号（仅 window error 事件提供） */
  lineno?: number
  /** 列号（仅 window error 事件提供） */
  colno?: number
}

/**
 * 把任意异常事件形态归一化为 RendererErrorInfo。
 *
 * 兼容三种输入：
 * - ErrorEvent（window 'error'）：优先取 .error（真实 Error 对象），
 *   跨域脚本等场景 .error 缺失时退回 message/filename/lineno/colno
 * - PromiseRejectionEvent（'unhandledrejection'）：reason 可能是 Error、
 *   字符串或任意对象（throw 非 Error 值时），无代码位置
 * - 直接传入的 Error / 字符串 / 任意值（单测与未来手动上报复用）
 *
 * @param ev - 事件对象或任意抛出值
 * @returns 归一化结果；无可用消息时返回 null（调用方丢弃）
 */
export function normalizeErrorEvent(ev: unknown): RendererErrorInfo | null {
  if (ev instanceof Error) {
    return ev.message ? { message: ev.message, stack: ev.stack } : null
  }
  if (ev && typeof ev === 'object') {
    const e = ev as Record<string, unknown>
    const isRejection = 'reason' in e
    let info: RendererErrorInfo | null = null
    // Promise 拒绝取 reason；error 事件优先取真实 Error（.error），
    // 缺失时（跨域脚本只有 "Script error." 文本消息）退回事件自身字段
    const errorLike = isRejection ? e.reason : e.error
    if (errorLike instanceof Error) {
      info = { message: errorLike.message, stack: errorLike.stack }
    } else {
      const raw = isRejection ? e.reason : e.message
      const message = raw == null ? '' : String(raw)
      if (message) info = { message }
    }
    if (!info) return null
    // 代码位置仅 error 事件携带；rejection 事件无对应字段
    if (!isRejection) {
      if (typeof e.filename === 'string' && e.filename) info.filename = e.filename
      if (typeof e.lineno === 'number' && e.lineno > 0) info.lineno = e.lineno
      if (typeof e.colno === 'number' && e.colno > 0) info.colno = e.colno
    }
    return info
  }
  if (typeof ev === 'string') return ev ? { message: ev } : null
  return null
}

/** 防止重复安装（HMR / 测试环境多次 boot） */
let installed = false

/**
 * 安装全局错误监听（捕获阶段，最早拿到事件）。
 * 浏览器环境（无 native API）静默不装。
 */
export function installErrorReport(): void {
  // 局部常量：让 TS 在闭包内保持「非 undefined」收窄
  const api = native
  if (installed || !api) return
  installed = true
  window.addEventListener(
    'error',
    (ev) => {
      const info = normalizeErrorEvent(ev)
      if (info) api.reportError(info)
    },
    true,
  )
  window.addEventListener(
    'unhandledrejection',
    (ev) => {
      const info = normalizeErrorEvent(ev)
      if (info) api.reportError(info)
    },
    true,
  )
}
