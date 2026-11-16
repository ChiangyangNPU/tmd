/**
 * prepare-gitee-release.mjs 单测：当前 Tauri 元数据校验与冻结迁移文件保护。
 * （GitHub Release 拉取与网络部分留在手动流程中验证）。
 *
 * @author chiangyang
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMetadata, writeMetadataFiles } from '../../scripts/prepare-gitee-release.mjs'

const VERSION = '0.2.2'
const LATEST = JSON.stringify({
  version: VERSION,
  platforms: {
    'windows-x86_64': { url: 'https://gitee.com/tmd.exe', signature: 'win-sig' },
    'darwin-aarch64': { url: 'https://gitee.com/TMD.app.tar.gz', signature: 'mac-sig' },
  },
})
const MIGRATION = JSON.stringify({ version: VERSION, downloads: {} })

describe('parseMetadata', () => {
  it('接受当前版本的 latest.json 与 migration.json', () => {
    expect(parseMetadata('latest.json', LATEST, VERSION).version).toBe(VERSION)
    expect(parseMetadata('migration.json', MIGRATION, VERSION).version).toBe(VERSION)
  })

  it('拒绝上一版元数据，防止补发时覆盖成旧版本', () => {
    expect(() => parseMetadata('migration.json', MIGRATION, '0.2.3')).toThrow('不一致')
  })

  it('latest.json 缺平台签名时拒绝发布', () => {
    const incomplete = JSON.stringify({
      version: VERSION,
      platforms: { 'windows-x86_64': { url: 'https://gitee.com/tmd.exe' } },
    })
    expect(() => parseMetadata('latest.json', incomplete, VERSION)).toThrow('下载地址或签名')
  })
})

describe('writeMetadataFiles', () => {
  it('只更新 Tauri JSON，冻结的 Electron YML 逐字节不变', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tmd-release-meta-'))
    try {
      const frozen = {
        'latest.yml': 'version: 0.1.8\npath: https://gitee.com/v0.2.1/TMD.exe\n',
        'latest-mac.yml': 'version: 0.1.8\npath: https://gitee.com/v0.2.1/TMD.dmg\n',
      }
      for (const [name, text] of Object.entries(frozen)) writeFileSync(path.join(dir, name), text)

      writeMetadataFiles(dir, { 'latest.json': LATEST, 'migration.json': MIGRATION })

      expect(readFileSync(path.join(dir, 'latest.json'), 'utf8')).toBe(LATEST)
      expect(readFileSync(path.join(dir, 'migration.json'), 'utf8')).toBe(MIGRATION)
      for (const [name, text] of Object.entries(frozen)) {
        expect(readFileSync(path.join(dir, name), 'utf8')).toBe(text)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
