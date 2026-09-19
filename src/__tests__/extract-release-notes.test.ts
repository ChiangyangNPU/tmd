/**
 * extract-release-notes.mjs 纯函数单测。
 * 重点回归：Windows CI 的 git checkout 会把 CHANGELOG.md 转成 CRLF，
 * 解析必须兼容（JS 正则的 . 不匹配 \r，按 \n 切会让标题带 \r 或匹配失败）。
 *
 * @author chiangyang
 */
import { describe, expect, it } from 'vitest'
import { parseSections } from '../../scripts/extract-release-notes.mjs'

const LF_SAMPLE = `# 更新日志

## [0.1.0] - 2026-09-19

首个正式发布版本。

### 编辑内核

- 所见即所得编辑

## [0.2.0]

- 下一版
`

describe('parseSections', () => {
  it('LF 文本：提取版本小节，到下一个 ## 为止', () => {
    const sections = parseSections(LF_SAMPLE)
    expect(sections.get('0.1.0')).toContain('首个正式发布版本。')
    expect(sections.get('0.1.0')).toContain('- 所见即所得编辑')
    expect(sections.get('0.1.0')).not.toContain('下一版')
    expect(sections.has('0.2.0')).toBe(true)
  })

  it('CRLF 文本：标题与小节同样可解析（Windows CI 回归）', () => {
    const crlf = LF_SAMPLE.replaceAll('\n', '\r\n')
    const sections = parseSections(crlf)
    expect(sections.has('0.1.0')).toBe(true)
    expect(sections.get('0.1.0')).toContain('首个正式发布版本。')
    // 节内容行不带残留 \r
    expect(sections.get('0.1.0')).not.toContain('\r')
  })

  it('混合行尾（CRLF 与 LF 交错）也能解析', () => {
    const mixed = '## [0.1.0]\r\n内容 A\n内容 B\r\n'
    const sections = parseSections(mixed)
    expect(sections.get('0.1.0')).toContain('内容 A')
    expect(sections.get('0.1.0')).toContain('内容 B')
  })

  it('无任何标题时返回空表', () => {
    expect(parseSections('没有标题的普通文本\n第二行').size).toBe(0)
  })
})
