import { describe, expect, it } from 'vitest'
import { MAX_TOTAL_PHYSICAL, TARGET_SCALE, planSegments, zoomForDpr } from '../export-image'

describe('zoomForDpr 清晰度归一', () => {
  it('归一后 zoom × dpr ≥ TARGET_SCALE（清晰度不低于 2x）', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) {
      expect(zoomForDpr(dpr) * dpr).toBeGreaterThanOrEqual(TARGET_SCALE)
    }
  })

  it('dpr=1 放大到 2x；dpr≥2 保持原生（不缩小以免降质）', () => {
    expect(zoomForDpr(1)).toBe(2)
    expect(zoomForDpr(1.25)).toBeCloseTo(1.6)
    expect(zoomForDpr(1.5)).toBeCloseTo(4 / 3)
    expect(zoomForDpr(2)).toBe(1)
    expect(zoomForDpr(2.5)).toBe(1)
    expect(zoomForDpr(3)).toBe(1)
  })

  it('dpr 非正数退回不缩放（zoom=1）', () => {
    expect(zoomForDpr(0)).toBe(1)
    expect(zoomForDpr(-2)).toBe(1)
  })
})

describe('planSegments 长图分段', () => {
  it('短文档单段：物理尺寸 = CSS 尺寸 × pixelRatio', () => {
    const r = planSegments(924, 1000, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.physicalWidth).toBe(1848)
    expect(r.plan.physicalHeight).toBe(2000)
    expect(r.plan.segments).toEqual([{ scrollYCss: 0, heightCss: 1000 }])
  })

  it('pixelRatio=2 时单段 CSS 高上限为 4000（物理不过 8000）', () => {
    const r = planSegments(924, 10000, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.requestHeightCss).toBe(4000)
    expect(r.plan.segments).toEqual([
      { scrollYCss: 0, heightCss: 4000 },
      { scrollYCss: 4000, heightCss: 4000 },
      { scrollYCss: 8000, heightCss: 2000 },
    ])
  })

  it('pixelRatio=1 时单段 CSS 高上限为 8000', () => {
    const r = planSegments(924, 10000, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.requestHeightCss).toBe(8000)
    expect(r.plan.segments).toEqual([
      { scrollYCss: 0, heightCss: 8000 },
      { scrollYCss: 8000, heightCss: 2000 },
    ])
  })

  it('有余数时末段高度取整（ceil），累计覆盖全部高度', () => {
    const r = planSegments(924, 4001, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.segments).toEqual([
      { scrollYCss: 0, heightCss: 4000 },
      { scrollYCss: 4000, heightCss: 1 },
    ])
  })

  it('每段物理高都不超过 8000 上限（含非整数 pixelRatio）', () => {
    const ratio = 1.6
    const r = planSegments(924, 50000, ratio)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const seg of r.plan.segments) {
      expect(seg.heightCss * ratio).toBeLessThanOrEqual(8000)
    }
    expect(r.plan.segments[1].scrollYCss).toBe(Math.floor(8000 / ratio))
  })

  it('空文档也产出一段，避免输出 0 高度图片', () => {
    const r = planSegments(924, 0, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.segments).toEqual([{ scrollYCss: 0, heightCss: 4000 }])
  })

  it('总物理高超过 120000 拒绝并返回实际高度', () => {
    const r = planSegments(924, 60001, 2)
    expect(r).toEqual({ ok: false, reason: 'too-tall', physicalHeight: 120002 })
  })

  it('边界：总物理高恰为上限时允许', () => {
    const r = planSegments(924, MAX_TOTAL_PHYSICAL / 2, 2)
    expect(r.ok).toBe(true)
  })
})
