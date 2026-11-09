/**
 * 架构迁移提示的纯函数单测（electron/updater.cjs）：
 * - 版本比较（含 prerelease 后缀宽松解析）
 * - 是否需要提示（严格高于当前版本）
 * - 平台下载地址选择与协议白名单
 */
import { describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  compareVersions,
  shouldPromptMigration,
  pickMigrationUrl,
  shouldShowMigrationPrompt,
  buildMigrationDetail,
} = require('../../electron/updater.cjs') as {
  compareVersions: (a: string, b: string) => number
  shouldPromptMigration: (current: string, info: unknown) => boolean
  pickMigrationUrl: (info: unknown, platform: string) => string | null
  shouldShowMigrationPrompt: (
    current: string,
    info: unknown,
    shellState: Record<string, unknown>,
  ) => boolean
  buildMigrationDetail: (info: unknown, platform: string) => string
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

describe('shouldShowMigrationPrompt（三态选择语义）', () => {
  const info = { version: '0.2.0' }
  test('首次命中提示', () => {
    expect(shouldShowMigrationPrompt('0.1.7', info, {})).toBe(true)
  })
  test('选过「稍后」同版本不再提示', () => {
    expect(shouldShowMigrationPrompt('0.1.7', info, { migrationPrompted: '0.2.0' })).toBe(false)
    // 新目标版本（下次发版）重新提示
    expect(
      shouldShowMigrationPrompt('0.1.7', { version: '0.3.0' }, { migrationPrompted: '0.2.0' }),
    ).toBe(true)
  })
  test('选过「继续使用 0.1.x」永久不提示', () => {
    expect(shouldShowMigrationPrompt('0.1.7', info, { migrationDeclined: true })).toBe(false)
  })
  test('目标不高于当前一律不提示', () => {
    expect(shouldShowMigrationPrompt('0.2.0', info, {})).toBe(false)
  })
})

describe('buildMigrationDetail（平台差异）', () => {
  test('macOS 说明替换旧版', () => {
    const d = buildMigrationDetail({ notes: '基础说明' }, 'darwin')
    expect(d).toContain('基础说明')
    expect(d).toContain('替换「应用程序」中的旧版')
  })
  test('Windows 说明需手动卸载旧版', () => {
    const d = buildMigrationDetail({ notes: '基础说明' }, 'win32')
    expect(d).toContain('基础说明')
    expect(d).toContain('卸载旧版')
    expect(d).toContain('不会自动移除')
  })
  test('缺 notes 用默认说明', () => {
    expect(buildMigrationDetail({ version: '0.2.0' }, 'darwin')).toContain('6MB')
  })
})
