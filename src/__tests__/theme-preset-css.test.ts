import { describe, it, expect } from 'vitest'
import { BUILTIN_PRESET_CSS, LIQUID_LENS_SVG, LENS_MAP_DATA_URI } from '../theme-preset-css'

describe('BUILTIN_PRESET_CSS', () => {
  it('包含全部四个非空预设（default/dark 为空串无需注入）', () => {
    expect(Object.keys(BUILTIN_PRESET_CSS)).toEqual(['sepia', 'green', 'glass', 'liquid'])
  })

  it.each(['sepia', 'green', 'glass', 'liquid'])('%s 同时覆盖浅色与深色', (id) => {
    const css = BUILTIN_PRESET_CSS[id]
    expect(css).toContain(`data-theme-preset='${id}']:not(.dark)`)
    expect(css).toContain(`data-theme-preset='${id}'].dark`)
  })

  it.each(['glass', 'liquid'])('%s 带打印与「降低透明度」双兜底', (id) => {
    const css = BUILTIN_PRESET_CSS[id]
    expect(css).toContain('@media print')
    expect(css).toContain('prefers-reduced-transparency')
  })
})

describe('液态玻璃 Pro 折射滤镜', () => {
  it('SVG 滤镜定义含 #tmd-lens 与位移原语（feImage + feDisplacementMap）', () => {
    expect(LIQUID_LENS_SVG).toContain('id="tmd-lens"')
    expect(LIQUID_LENS_SVG).toContain('<feImage')
    expect(LIQUID_LENS_SVG).toContain('feDisplacementMap')
    expect(LIQUID_LENS_SVG).toContain('data:image/png;base64,')
  })

  it('liquid 预设折射链引用 #tmd-lens；纸张链（大表面）不做位移', () => {
    const css = BUILTIN_PRESET_CSS.liquid
    const glassVar = css.match(/--lq-glass: ([^;]+);/)?.[1] ?? ''
    const paperVar = css.match(/--lq-paper-glass: ([^;]+);/)?.[1] ?? ''
    expect(glassVar).toContain('url(#tmd-lens)')
    expect(paperVar).not.toContain('url(#tmd-lens)')
    expect(paperVar).toContain('blur(')
  })

  it('位移图是合法 PNG data URI（PNG 魔数开头）', () => {
    // iVBORw0KGgo = \x89PNG\r\n\x1a\n 的 base64 前缀
    expect(LENS_MAP_DATA_URI.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true)
  })
})
