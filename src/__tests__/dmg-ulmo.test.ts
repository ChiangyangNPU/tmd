/**
 * patch-mac-dmg.mjs 的纯函数部分单测：dmg 转 ULMO 后 latest-mac.yml 的
 * sha512/size 修补（真实转换与 hdiutil 相关，留在打包流程中人工验证）。
 *
 * @author chiangyang
 */
import { describe, expect, it } from 'vitest'
import { patchUpdateYml } from '../../scripts/patch-mac-dmg.mjs'

/** electron-builder 生成的 latest-mac.yml 形态（节选自真实产物） */
const SAMPLE = `version: 0.1.0
files:
  - url: TMD-0.1.0-arm64.dmg
    sha512: AAAAOLD/SHA==
    size: 102815617
path: TMD-0.1.0-arm64.dmg
sha512: AAAAOLD/SHA==
size: 102815617
releaseNotes: |
  ## [0.1.0]

  首个正式发布版本。
releaseDate: '2026-09-19T10:57:35.726Z'
`

describe('patchUpdateYml', () => {
  const patch = { sha512: 'BBBBNEW/SHA==', size: 85241120 }

  it('按 url 修补 files 条目与顶层引用的 sha512/size', () => {
    const out = patchUpdateYml(SAMPLE, 'TMD-0.1.0-arm64.dmg', patch)
    expect(out).toContain(
      '- url: TMD-0.1.0-arm64.dmg\n    sha512: BBBBNEW/SHA==\n    size: 85241120',
    )
    expect(out).toContain('path: TMD-0.1.0-arm64.dmg\nsha512: BBBBNEW/SHA==\nsize: 85241120')
    expect(out).not.toContain('AAAAOLD')
  })

  it('不触碰 releaseNotes 等其余内容', () => {
    const out = patchUpdateYml(SAMPLE, 'TMD-0.1.0-arm64.dmg', patch)
    expect(out).toContain('releaseNotes: |\n  ## [0.1.0]\n\n  首个正式发布版本。')
    expect(out).toContain("releaseDate: '2026-09-19T10:57:35.726Z'")
  })

  it('多产物时只修补 url 匹配的条目', () => {
    const multi = `version: 0.1.0
files:
  - url: TMD-0.1.0-arm64-mac.zip
    sha512: OLDZIP/SHA==
    size: 111111111
  - url: TMD-0.1.0-arm64.dmg
    sha512: AAAAOLD/SHA==
    size: 102815617
`
    const out = patchUpdateYml(multi, 'TMD-0.1.0-arm64.dmg', patch)
    expect(out).toContain('sha512: OLDZIP/SHA==\n    size: 111111111')
    expect(out).toContain('- url: TMD-0.1.0-arm64.dmg\n    sha512: BBBBNEW/SHA==')
  })

  it('真实形态：顶层只有 path/sha512（无 size 行）时只修 sha，不新增行', () => {
    const noTopSize = `version: 0.1.0
files:
  - url: TMD-0.1.0-arm64.dmg
    sha512: AAAAOLD/SHA==
    size: 102815617
path: TMD-0.1.0-arm64.dmg
sha512: AAAAOLD/SHA==
releaseNotes: |
  ## [0.1.0]

  首个正式发布版本。
releaseDate: '2026-09-19T10:57:35.726Z'
`
    const out = patchUpdateYml(noTopSize, 'TMD-0.1.0-arm64.dmg', patch)
    expect(out).toContain('path: TMD-0.1.0-arm64.dmg\nsha512: BBBBNEW/SHA==\nreleaseNotes: |')
    expect(out).not.toContain('AAAAOLD')
  })

  it('文件名中的正则元字符按字面匹配（. 不吞任意字符）', () => {
    const tricky = SAMPLE.replaceAll('TMD-0.1.0-arm64.dmg', 'TMD-0.1.0-arm64Xdmg')
    expect(() => patchUpdateYml(tricky, 'TMD-0.1.0-arm64.dmg', patch)).toThrow()
  })

  it('条目缺失时抛错（拒绝产出不一致的元数据）', () => {
    expect(() => patchUpdateYml(SAMPLE, 'TMD-9.9.9-arm64.dmg', patch)).toThrow('找不到')
  })
})
