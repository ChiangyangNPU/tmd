import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// electron/themes.cjs 是纯 Node CJS 模块（不依赖 Electron），
// 经 createRequire 直接加载验证扫描/校验逻辑（与主进程同一代码路径）
const require = createRequire(import.meta.url)
const themes = require('../../electron/themes.cjs') as {
  themesDir: (home: string) => string
  isThemeFileName: (name: unknown) => boolean
  safeThemeName: (name: unknown) => string | null
  themeDisplayName: (name: string) => string
  listThemeFiles: (dir: string, locale?: string) => Promise<{ name: string }[]>
  readThemeFile: (dir: string, name: unknown) => Promise<string | null>
  ensureThemesDirWithSample: (dir: string) => Promise<{ sampleWritten: boolean }>
  SAMPLE_THEME_FILE: string
  THEME_MAX_SIZE: number
}

let tempRoot: string

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tmd-themes-'))
})

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('isThemeFileName / safeThemeName', () => {
  it('收录普通 .css（含中文与大写扩展名）', () => {
    expect(themes.isThemeFileName('晚霞.css')).toBe(true)
    expect(themes.isThemeFileName('a.CSS')).toBe(true)
    expect(themes.isThemeFileName('my-theme.Css')).toBe(true)
  })

  it('拒绝隐藏文件、空主名与非 css 扩展名', () => {
    expect(themes.isThemeFileName('.hidden.css')).toBe(false)
    expect(themes.isThemeFileName('.css')).toBe(false)
    expect(themes.isThemeFileName('x.txt')).toBe(false)
    expect(themes.isThemeFileName('css')).toBe(false)
    expect(themes.isThemeFileName('x.css.bak')).toBe(false)
  })

  it('拒绝路径片段与路径穿越（分隔符、..、非字符串）', () => {
    expect(themes.isThemeFileName('../evil.css')).toBe(false)
    expect(themes.isThemeFileName('../../etc/passwd.css')).toBe(false)
    expect(themes.isThemeFileName('a/b.css')).toBe(false)
    expect(themes.isThemeFileName('a\\b.css')).toBe(false)
    expect(themes.isThemeFileName('')).toBe(false)
    expect(themes.isThemeFileName(123)).toBe(false)
    expect(themes.isThemeFileName(null)).toBe(false)
    expect(themes.isThemeFileName(undefined)).toBe(false)
  })

  it('safeThemeName 命中时原样返回，否则 null', () => {
    expect(themes.safeThemeName('晚霞.css')).toBe('晚霞.css')
    expect(themes.safeThemeName('../evil.css')).toBeNull()
    expect(themes.safeThemeName(undefined)).toBeNull()
  })
})

describe('themeDisplayName', () => {
  it('去掉 .css 扩展名（大小写不敏感）', () => {
    expect(themes.themeDisplayName('晚霞.css')).toBe('晚霞')
    expect(themes.themeDisplayName('a.CSS')).toBe('a')
  })
})

describe('themesDir', () => {
  it('拼出 ~/.tmd/themes', () => {
    const dir = themes.themesDir(path.join(tempRoot, 'home'))
    expect(dir.split(path.sep).slice(-2)).toEqual(['.tmd', 'themes'])
  })
})

describe('listThemeFiles', () => {
  it('只收录一层 .css 并按名称排序；目录不存在返回空数组', async () => {
    const dir = path.join(tempRoot, 'list')
    expect(await themes.listThemeFiles(dir)).toEqual([])

    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'b.css'), ':root{}')
    await writeFile(path.join(dir, 'a.css'), ':root{}')
    await writeFile(path.join(dir, 'note.txt'), 'x')
    await writeFile(path.join(dir, '.secret.css'), 'x')
    await mkdir(path.join(dir, 'nested.css'), { recursive: true })

    const list = await themes.listThemeFiles(dir)
    expect(list).toEqual([{ name: 'a.css' }, { name: 'b.css' }])
  })
})

describe('readThemeFile', () => {
  it('正常读取主题内容', async () => {
    const dir = path.join(tempRoot, 'read')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'ok.css'), 'body { color: red; }')
    expect(await themes.readThemeFile(dir, 'ok.css')).toBe('body { color: red; }')
  })

  it('拒绝非法文件名与不存在的文件', async () => {
    const dir = path.join(tempRoot, 'read')
    expect(await themes.readThemeFile(dir, '../evil.css')).toBeNull()
    expect(await themes.readThemeFile(dir, 'a/b.css')).toBeNull()
    expect(await themes.readThemeFile(dir, 42)).toBeNull()
    expect(await themes.readThemeFile(dir, 'missing.css')).toBeNull()
  })

  it('超过大小上限的文件返回 null', async () => {
    const dir = path.join(tempRoot, 'read')
    await writeFile(path.join(dir, 'big.css'), 'x'.repeat(themes.THEME_MAX_SIZE + 1))
    expect(await themes.readThemeFile(dir, 'big.css')).toBeNull()
  })
})

describe('ensureThemesDirWithSample', () => {
  it('目录不存在时创建并写入示例主题', async () => {
    const dir = path.join(tempRoot, 'ensure-new')
    const result = await themes.ensureThemesDirWithSample(dir)
    expect(result.sampleWritten).toBe(true)
    const content = await readFile(path.join(dir, themes.SAMPLE_THEME_FILE), 'utf-8')
    expect(content).toContain(':root')
    expect(content).toContain('html.dark')
  })

  it('目录中已有 .css 时不再写入示例', async () => {
    const dir = path.join(tempRoot, 'ensure-existing')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'mine.css'), ':root{}')
    const result = await themes.ensureThemesDirWithSample(dir)
    expect(result.sampleWritten).toBe(false)
    expect(await themes.listThemeFiles(dir)).toEqual([{ name: 'mine.css' }])
  })

  it('空目录（仅有非 css 文件）时补写示例', async () => {
    const dir = path.join(tempRoot, 'ensure-empty')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'readme.txt'), 'x')
    const result = await themes.ensureThemesDirWithSample(dir)
    expect(result.sampleWritten).toBe(true)
  })
})
