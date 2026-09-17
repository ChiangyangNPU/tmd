import { describe, it, expect } from 'vitest'
import { normalizeErrorEvent } from '../error-report'

describe('normalizeErrorEvent', () => {
  it('直接传入 Error 实例：取 message 与 stack', () => {
    const err = new Error('boom')
    expect(normalizeErrorEvent(err)).toEqual({ message: 'boom', stack: err.stack })
  })

  it('空消息的 Error 返回 null', () => {
    expect(normalizeErrorEvent(new Error(''))).toBeNull()
  })

  it('error 事件（ErrorEvent 形态）：优先取真实 Error 并附带代码位置', () => {
    const err = new Error('real')
    const event = {
      message: 'fallback',
      error: err,
      filename: 'https://x/app.js',
      lineno: 42,
      colno: 7,
    }
    expect(normalizeErrorEvent(event)).toEqual({
      message: 'real',
      stack: err.stack,
      filename: 'https://x/app.js',
      lineno: 42,
      colno: 7,
    })
  })

  it('跨域脚本 error 为 null 时退回事件文本消息（如 Script error.）', () => {
    const event = {
      message: 'Script error.',
      error: null,
      filename: '',
      lineno: 0,
      colno: 0,
    }
    expect(normalizeErrorEvent(event)).toEqual({ message: 'Script error.' })
  })

  it('PromiseRejectionEvent：reason 为 Error 时取其堆栈，且不补代码位置', () => {
    const err = new Error('rejected')
    expect(normalizeErrorEvent({ reason: err })).toEqual({
      message: 'rejected',
      stack: err.stack,
    })
  })

  it('Promise 拒绝非 Error 值：安全字符串化', () => {
    expect(normalizeErrorEvent({ reason: 'string throw' })).toEqual({
      message: 'string throw',
    })
    expect(normalizeErrorEvent({ reason: 404 })).toEqual({ message: '404' })
    expect(normalizeErrorEvent({ reason: { code: 1 } })).toEqual({
      message: '[object Object]',
    })
  })

  it('字符串 / null / undefined / 空串兜底', () => {
    expect(normalizeErrorEvent('raw string')).toEqual({ message: 'raw string' })
    expect(normalizeErrorEvent('')).toBeNull()
    expect(normalizeErrorEvent(null)).toBeNull()
    expect(normalizeErrorEvent(undefined)).toBeNull()
  })

  it('拒绝原因缺失（{reason: undefined}）返回 null', () => {
    expect(normalizeErrorEvent({ reason: undefined })).toBeNull()
  })
})
