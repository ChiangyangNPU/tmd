import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * ai-config.cjs 的持久化行为：
 * 默认值、增量合并、Key 加密落盘、渲染层视图脱敏、URL / 温度归一化、
 * 文件损坏静默降级。主进程配置是 AI 功能的安全边界，这里逐条锁死。
 */

/** 假 safeStorage：加前缀后 base64，等价于「落盘内容不含明文」 */
interface FakeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

interface AiConfigApi {
  read(): Record<string, unknown> & { apiKey: string }
  publicView(): {
    enabled: boolean
    provider: string
    baseUrl: string
    model: string
    temperature: number
    hasApiKey: boolean
    apiKeyLength: number
    providers: { id: string; baseUrl: string; model: string; needsKey: boolean }[]
    context: { selection: boolean; document: boolean; workspace: boolean }
  }
  save(patch: Record<string, unknown>): ReturnType<AiConfigApi['publicView']>
  getClientConfig(overrides?: unknown): {
    provider: string
    baseUrl: string
    model: string
    apiKey: string
    needsKey: boolean
    embedModel: string
  }
}

const require = createRequire(import.meta.url)
const { createAiConfig, AI_PROVIDERS } = require('../../electron/ai-config.cjs') as {
  createAiConfig: (deps: {
    app: { getPath: (name: string) => string }
    safeStorage?: FakeStorage | null
  }) => AiConfigApi
  AI_PROVIDERS: Record<string, unknown>
}

const fakeStorage: FakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
}

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmd-ai-config-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 在临时 userData 目录上创建配置服务 */
function create(safeStorage: FakeStorage | null = fakeStorage) {
  return createAiConfig({ app: { getPath: () => dir }, safeStorage })
}

describe('ai-config 默认值与合并', () => {
  it('首次读取给出默认值：关闭、DeepSeek、只发选区', () => {
    const config = create()
    const view = config.publicView()
    expect(view.enabled).toBe(false)
    expect(view.provider).toBe('deepseek')
    expect(view.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(view.model).toBe('deepseek-chat')
    expect(view.temperature).toBe(0.7)
    expect(view.context).toEqual({ selection: true, document: false, workspace: false })
    expect(view.hasApiKey).toBe(false)
    expect(view.apiKeyLength).toBe(0)
  })

  it('增量保存只改传入字段，context 嵌套项单独合并', () => {
    const config = create()
    config.save({ enabled: true })
    config.save({ context: { document: true } })
    const view = config.publicView()
    expect(view.enabled).toBe(true)
    expect(view.context).toEqual({ selection: true, document: true, workspace: false })
    expect(view.provider).toBe('deepseek')
  })

  it('温度按 0–2 钳制，非法值回落默认', () => {
    const config = create()
    expect(config.save({ temperature: 9 }).temperature).toBe(2)
    expect(config.save({ temperature: -3 }).temperature).toBe(0)
    expect(config.save({ temperature: Number.NaN }).temperature).toBe(0.7)
  })

  it('baseUrl 去掉尾部斜杠，非 http(s) 回落到预设', () => {
    const config = create()
    expect(config.save({ baseUrl: 'https://api.test/v1/' }).baseUrl).toBe('https://api.test/v1')
    expect(config.save({ provider: 'ollama', baseUrl: 'file:///etc/passwd' }).baseUrl).toBe(
      (AI_PROVIDERS.ollama as { baseUrl: string }).baseUrl,
    )
  })

  it('切换到自定义服务商允许空的地址与模型', () => {
    const config = create()
    const view = config.save({ provider: 'custom', baseUrl: '', model: '' })
    expect(view.provider).toBe('custom')
    expect(view.baseUrl).toBe('')
    expect(view.model).toBe('')
  })

  it('配置文件损坏时静默回落到默认值', () => {
    fs.writeFileSync(path.join(dir, 'ai-config.json'), '{ not json', 'utf-8')
    const view = create().publicView()
    expect(view.provider).toBe('deepseek')
    expect(view.enabled).toBe(false)
  })

  it('视图下发全部内置服务商预设', () => {
    const view = create().publicView()
    const ids = view.providers.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining(['openai', 'deepseek', 'moonshot', 'zhipu', 'ollama', 'custom']),
    )
  })
})

describe('ai-config 的 API Key 处理', () => {
  it('Key 以密文落盘，读取时解密，渲染层视图不含明文', () => {
    const config = create()
    const view = config.save({ apiKey: 'sk-secret-value' })
    const raw = fs.readFileSync(path.join(dir, 'ai-config.json'), 'utf-8')
    expect(raw).not.toContain('sk-secret-value')
    expect(view.hasApiKey).toBe(true)
    expect(view.apiKeyLength).toBe('sk-secret-value'.length)
    expect('apiKey' in view).toBe(false)
    expect(config.read().apiKey).toBe('sk-secret-value')
  })

  it('保存其他字段不会丢失已存 Key', () => {
    const config = create()
    config.save({ apiKey: 'sk-keep' })
    config.save({ model: 'deepseek-reasoner' })
    expect(config.read().apiKey).toBe('sk-keep')
    expect(config.read().model).toBe('deepseek-reasoner')
  })

  it('clearApiKey 清除密钥；空串不会误清', () => {
    const config = create()
    config.save({ apiKey: 'sk-keep' })
    config.save({ apiKey: '' })
    expect(config.read().apiKey).toBe('sk-keep')
    const view = config.save({ clearApiKey: true })
    expect(view.hasApiKey).toBe(false)
    expect(config.read().apiKey).toBe('')
  })

  it('safeStorage 不可用时降级为明文但仍可读写', () => {
    const config = create(null)
    config.save({ apiKey: 'sk-plain' })
    expect(config.read().apiKey).toBe('sk-plain')
  })

  it('密文无法解密时返回空串而不抛错', () => {
    const config = create({
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('enc:x'),
      decryptString: () => {
        throw new Error('keyring changed')
      },
    })
    config.save({ apiKey: 'sk-broken' })
    expect(config.read().apiKey).toBe('')
  })
})

describe('ai-config 请求参数组装', () => {
  it('表单覆盖值优先于已存配置', () => {
    const config = create()
    config.save({ apiKey: 'sk-stored', model: 'stored-model' })
    const cfg = config.getClientConfig({ model: 'form-model', apiKey: 'sk-form' })
    expect(cfg.model).toBe('form-model')
    expect(cfg.apiKey).toBe('sk-form')
  })

  it('覆盖服务商时使用该预设的地址与模型', () => {
    const config = create()
    const cfg = config.getClientConfig({ provider: 'ollama' })
    expect(cfg.baseUrl).toBe((AI_PROVIDERS.ollama as { baseUrl: string }).baseUrl)
    expect(cfg.model).toBe((AI_PROVIDERS.ollama as { model: string }).model)
    expect(cfg.needsKey).toBe(false)
  })

  it('未覆盖时沿用已保存的连接配置', () => {
    const config = create()
    config.save({ provider: 'openai', model: 'gpt-4o-mini' })
    const cfg = config.getClientConfig()
    expect(cfg.provider).toBe('openai')
    expect(cfg.needsKey).toBe(true)
    expect(cfg.baseUrl).toBe((AI_PROVIDERS.openai as { baseUrl: string }).baseUrl)
  })

  it('embedModel 取已存值，表单覆盖优先并裁剪空白', () => {
    const config = create()
    config.save({ embedModel: 'text-embedding-3-small' })
    expect(config.getClientConfig().embedModel).toBe('text-embedding-3-small')
    const overridden = config.getClientConfig({ embedModel: '  custom-embed  ' })
    expect(overridden.embedModel).toBe('custom-embed')
  })
})
