import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * 壳层能力探测：Tauri 版没有图床/未配置更新器时，渲染层必须靠
 * `capabilities` 提前降级，而不是调用后拿到 undefined 再崩。
 *
 * native.ts 在模块加载时把 window.tmdAPI 抓成常量，因此每个用例都要
 * resetModules + 重新 stub 后再动态 import。
 */
async function loadWith(api: unknown) {
  vi.resetModules()
  vi.stubGlobal('window', { tmdAPI: api })
  return import('../native')
}

describe('hasNativeFeature 壳层能力探测', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { tmdAPI: undefined })
  })

  it('浏览器模式（无 native）一律 false', async () => {
    const { hasNativeFeature, native } = await loadWith(undefined)
    expect(native).toBeUndefined()
    expect(hasNativeFeature('picgo')).toBe(false)
    expect(hasNativeFeature('updater')).toBe(false)
  })

  it('壳层未声明 capabilities 时按支持处理（Electron 版行为不变）', async () => {
    const { hasNativeFeature } = await loadWith({ isNative: true })
    expect(hasNativeFeature('picgo')).toBe(true)
    expect(hasNativeFeature('updater')).toBe(true)
  })

  it('显式 false 的能力整块不可用', async () => {
    const { hasNativeFeature } = await loadWith({
      isNative: true,
      capabilities: { picgo: false, updater: true },
    })
    expect(hasNativeFeature('picgo')).toBe(false)
    expect(hasNativeFeature('updater')).toBe(true)
  })

  it('能力只关一项时其余保持可用', async () => {
    const { hasNativeFeature } = await loadWith({
      isNative: true,
      capabilities: { picgo: true, updater: false },
    })
    expect(hasNativeFeature('picgo')).toBe(true)
    expect(hasNativeFeature('updater')).toBe(false)
  })
})
