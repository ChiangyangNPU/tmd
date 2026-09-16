import { describe, it, expect } from 'vitest'
import { PICGO_FIELDS } from '../settings'

/** 内置图床类型清单（与 index.html 中 <select> 的 <option> 对齐） */
const BUILTIN_UPLOADERS = ['smms', 'github', 'qiniu', 'upyun', 'tcyun', 'aliyun', 'imgur']

/** 需要密文显示的字段名（type 应为 password） */
const SENSITIVE_KEYS = ['token', 'secretKey', 'password', 'accessKeySecret']

describe('PICGO_FIELDS 图床配置字段定义', () => {
  it('所有内置图床都有字段定义', () => {
    for (const uploader of BUILTIN_UPLOADERS) {
      expect(PICGO_FIELDS[uploader]).toBeDefined()
      expect(Array.isArray(PICGO_FIELDS[uploader])).toBe(true)
      expect(PICGO_FIELDS[uploader].length).toBeGreaterThan(0)
    }
  })

  it('每个字段都有 key 和 label', () => {
    for (const uploader of BUILTIN_UPLOADERS) {
      for (const field of PICGO_FIELDS[uploader]) {
        expect(typeof field.key).toBe('string')
        expect(field.key.length).toBeGreaterThan(0)
        expect(typeof field.label).toBe('string')
        expect(field.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('同一图床内字段 key 不重复', () => {
    for (const uploader of BUILTIN_UPLOADERS) {
      const keys = PICGO_FIELDS[uploader].map((f) => f.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('敏感字段（token/secretKey/password 等）使用 password 类型', () => {
    for (const uploader of BUILTIN_UPLOADERS) {
      for (const field of PICGO_FIELDS[uploader]) {
        if (SENSITIVE_KEYS.includes(field.key)) {
          expect(field.type).toBe('password')
        }
      }
    }
  })

  it('SM.MS 只需 token 字段', () => {
    expect(PICGO_FIELDS.smms.map((f) => f.key)).toEqual(['token'])
  })

  it('GitHub 包含 repo/branch/token/path/customUrl', () => {
    const keys = PICGO_FIELDS.github.map((f) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining(['repo', 'branch', 'token', 'path', 'customUrl']),
    )
  })
})
