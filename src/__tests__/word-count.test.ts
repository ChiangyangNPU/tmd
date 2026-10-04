import { describe, it, expect } from 'vitest'
import { formatWordCount } from '../editor-core'

// editor.wordCount = '{count} 字'；wordCountSelected = '已选 {selected} / 共 {total} 字'
// （以 zh-CN 语言包为准的断言文案形态）
describe('formatWordCount（工具栏字数文案）', () => {
  it('无选区：仅全文计数', () => {
    expect(formatWordCount(100)).toBe('100 字')
    expect(formatWordCount(100, 0)).toBe('100 字')
  })

  it('有选区：已选 / 全文双数字', () => {
    expect(formatWordCount(100, 7)).toBe('已选 7 / 共 100 字')
  })

  it('选区数大于全文时仍如实展示（调用方保证入参，不在此钳制）', () => {
    expect(formatWordCount(5, 9)).toBe('已选 9 / 共 5 字')
  })
})
