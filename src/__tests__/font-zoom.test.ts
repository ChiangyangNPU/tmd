import { describe, it, expect } from 'vitest'
import { nextFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT } from '../typography'

describe('nextFontSize（Ctrl/Cmd+滚轮缩放的纯函数）', () => {
  it('空档位按默认 16 起算', () => {
    expect(nextFontSize('', 1)).toBe(String(FONT_SIZE_DEFAULT + 1))
    expect(nextFontSize('', -1)).toBe(String(FONT_SIZE_DEFAULT - 1))
    expect(FONT_SIZE_DEFAULT).toBe(16)
  })

  it('数字档位逐级 ±1', () => {
    expect(nextFontSize('16', 1)).toBe('17')
    expect(nextFontSize('16', -1)).toBe('15')
    expect(nextFontSize('20', 3)).toBe('23')
  })

  it('非法档位（非数字）按默认值起算', () => {
    expect(nextFontSize('abc', 1)).toBe('17')
  })

  it('钳制在 [MIN, MAX]，边界连续缩放不越界', () => {
    expect(nextFontSize(String(FONT_SIZE_MAX), 1)).toBe(String(FONT_SIZE_MAX))
    expect(nextFontSize(String(FONT_SIZE_MIN), -1)).toBe(String(FONT_SIZE_MIN))
    expect(FONT_SIZE_MIN).toBeLessThan(FONT_SIZE_DEFAULT)
    expect(FONT_SIZE_MAX).toBeGreaterThan(FONT_SIZE_DEFAULT)
  })
})
