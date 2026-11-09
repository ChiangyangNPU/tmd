/**
 * 架构迁移提示的纯函数单测（electron/updater.cjs）：
 * - 版本比较（含 prerelease 后缀宽松解析）
 * - 是否需要提示（严格高于当前版本）
 * - 平台下载地址选择与协议白名单
 */
import { describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compareVersions, shouldPromptMigration, pickMigrationUrl } = require(
  '../../electron/updater.cjs',
) as {
  compareVersions: (a: string, b: string) => number
  shouldPromptMigration: (current: string, info: unknown) => boolean
  pickMigrationUrl: (info: unknown, platform: string) => string | null
}

describe('compareVersions', () => {
  test('三段数字比较', () => {
    expect(compareVersions('0.2.0', '0.1.7')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.1.7', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })
  test('prerelease 后缀按主版本段比较', () => {
    expect(compareVersions('0.2.0-beta.1', '0.1.7')).toBe(1)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0)
  })
})

describe('shouldPromptMigration', () => {
  test('目标严格高于当前才提示', () => {
    expect(shouldPromptMigration('0.1.7', { version: '0.2.0' })).toBe(true)
    expect(shouldPromptMigration('0.2.0', { version: '0.2.0' })).toBe(false)
    expect(shouldPromptMigration('0.2.1', { version: '0.2.0' })).toBe(false)
  })
  test('非法元数据一律不提示', () => {
    expect(shouldPromptMigration('0.1.7', null)).toBe(false)
    expect(shouldPromptMigration('0.1.7', {})).toBe(false)
    expect(shouldPromptMigration('0.1.7', { version: 2 })).toBe(false)
    expect(shouldPromptMigration('0.1.7', { version: '  ' })).toBe(false)
  })
})

describe('pickMigrationUrl', () => {
  const info = {
    version: '0.2.0',
    downloads: {
      darwin: 'https://gitee.com/x/TMD_0.2.0_aarch64.dmg',
      win32: 'https://gitee.com/x/TMD_0.2.0_x64-setup.exe',
    },
  }
  test('按平台取地址', () => {
    expect(pickMigrationUrl(info, 'darwin')).toContain('.dmg')
    expect(pickMigrationUrl(info, 'win32')).toContain('-setup.exe')
  })
  test('缺字段/非法协议返回 null', () => {
    expect(pickMigrationUrl(null, 'darwin')).toBeNull()
    expect(pickMigrationUrl({ version: '0.2.0' }, 'darwin')).toBeNull()
    expect(pickMigrationUrl({ downloads: { darwin: 'javascript:alert(1)' } }, 'darwin')).toBeNull()
    expect(pickMigrationUrl({ downloads: { darwin: 'file:///etc/passwd' } }, 'darwin')).toBeNull()
  })
})
