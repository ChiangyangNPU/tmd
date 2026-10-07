/**
 * 字体预设纯函数单元测试：presetStack 的栈计算——
 * ① 默认顺序与历史存储的旧栈字符串逐字节一致（设置面板 radio 按栈相等
 *    回显，兼容性破坏会让旧用户的预设选择丢失）；
 * ② 二级主字体置首且其余保序；③ 兜底通用族殿后。
 */
import { describe, expect, test } from 'vitest'
import { FONT_PRESETS, presetStack } from '../typography'

describe('presetStack 字体栈计算', () => {
  test('默认顺序与历史存储的旧栈字符串逐字节一致', () => {
    const song = FONT_PRESETS.find((p) => p.id === 'song')
    expect(song && presetStack(song)).toBe(
      `Georgia, 'Songti SC', SimSun, 'Noto Serif CJK SC', serif`,
    )
    const hei = FONT_PRESETS.find((p) => p.id === 'hei')
    expect(hei && presetStack(hei)).toBe(
      `'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`,
    )
  })

  test('二级主字体置于栈首，其余保持原优先级', () => {
    const song = FONT_PRESETS.find((p) => p.id === 'song')
    expect(song && presetStack(song, "'Songti SC'")).toBe(
      `'Songti SC', Georgia, SimSun, 'Noto Serif CJK SC', serif`,
    )
    expect(song && presetStack(song, "'Noto Serif CJK SC'")).toBe(
      `'Noto Serif CJK SC', Georgia, 'Songti SC', SimSun, serif`,
    )
  })

  test('兜底通用族恒在栈尾', () => {
    for (const preset of FONT_PRESETS) {
      const stack = presetStack(preset)
      expect(stack.endsWith(preset.generic)).toBe(true)
    }
  })

  test('全部预设的栈两两不同（radio 按栈回显依赖唯一性）', () => {
    const stacks = FONT_PRESETS.filter((p) => p.fonts.length > 0).map((p) => presetStack(p))
    expect(new Set(stacks).size).toBe(stacks.length)
  })
})
