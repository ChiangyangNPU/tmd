/**
 * prepare-gitee-release.mjs 纯函数单测：元数据 url 绝对化
 * （GitHub Release 拉取与网络部分留在手动流程中验证）。
 *
 * @author chiangyang
 */
import { describe, expect, it } from 'vitest'
import { absolutizeYmlUrls } from '../../scripts/prepare-gitee-release.mjs'

const toAbsolute = (name: string) =>
  `https://gitee.com/ChiangyangNPU/tmd/releases/download/v0.1.0/${name}`

const WIN_YML = `version: 0.1.0
files:
  - url: TMD-0.1.0-x64-Setup.exe
    sha512: AAAA==
    size: 94208000
  - url: TMD-0.1.0-x64-Setup.exe.blockmap
    sha512: BBBB==
    size: 102400
path: TMD-0.1.0-x64-Setup.exe
sha512: AAAA==
releaseNotes: |
  ## [0.1.0]

  首个正式发布版本。
releaseDate: '2026-09-19T10:57:35.726Z'
`

describe('absolutizeYmlUrls', () => {
  it('files 条目的 url 与顶层 path 都改为绝对 URL', () => {
    const out = absolutizeYmlUrls(WIN_YML, toAbsolute)
    expect(out).toContain(
      '- url: https://gitee.com/ChiangyangNPU/tmd/releases/download/v0.1.0/TMD-0.1.0-x64-Setup.exe\n',
    )
    expect(out).toContain(
      'path: https://gitee.com/ChiangyangNPU/tmd/releases/download/v0.1.0/TMD-0.1.0-x64-Setup.exe',
    )
    // blockmap 同样被处理
    expect(out).toContain(
      '- url: https://gitee.com/ChiangyangNPU/tmd/releases/download/v0.1.0/TMD-0.1.0-x64-Setup.exe.blockmap',
    )
  })

  it('sha512/size/releaseNotes 等内容不受影响', () => {
    const out = absolutizeYmlUrls(WIN_YML, toAbsolute)
    expect(out).toContain('sha512: AAAA==')
    expect(out).toContain('size: 94208000')
    expect(out).toContain('releaseNotes: |\n  ## [0.1.0]\n\n  首个正式发布版本。')
  })

  it('releaseNotes 正文里形如 url/path 的普通文本不被误替换（无行首锚点不匹配）', () => {
    const withText = WIN_YML.replace(
      '  首个正式发布版本。',
      '  修复了 url: 解析问题与 path: 拼接问题',
    )
    const out = absolutizeYmlUrls(withText, toAbsolute)
    expect(out).toContain('修复了 url: 解析问题与 path: 拼接问题')
  })

  it('幂等：已是绝对 URL 时重复运行不重复包装', () => {
    const once = absolutizeYmlUrls(WIN_YML, toAbsolute)
    const twice = absolutizeYmlUrls(once, toAbsolute)
    expect(twice).toBe(once)
  })
})
