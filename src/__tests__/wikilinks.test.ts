/**
 * 双链扫描与解析（electron/wikilinks.cjs，纯 Node 模块）单元测试：
 * - 逐文件 wikilink 解析（围栏块跳过 / 行号 / 空内容不成节点）
 * - resolveTarget 三档解析（相对路径 / 同目录同名 / 全工作区唯一名 / 多同名）
 * - scanWikiLinks 端到端（临时目录 fixture，与 filewatcher/history 测试同范式）
 */
import { describe, expect, test, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wikilinks = require('../../electron/wikilinks.cjs') as {
  scanWikiLinks: (roots: string[]) => Promise<{
    notes: { path: string; name: string }[]
    links: {
      source: string
      target: string
      heading: string
      alias: string
      line: number
      text: string
      resolved: { kind: string; path?: string; paths?: string[] }
    }[]
    truncated: boolean
  }>
  resolveTarget: (
    target: string,
    sourcePath: string,
    index: unknown,
  ) => { kind: string; path?: string; paths?: string[] }
  parseWikiInner: (inner: string) => { target: string; alias: string; heading: string }
}

const tmpDirs: string[] = []
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
})

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tmd-wiki-'))
  tmpDirs.push(root)
  await mkdir(path.join(root, 'sub'), { recursive: true })
  // sub2 无同名 d.md：其 [[d]] 才会走到「全工作区唯一名」档并命中多同名
  await mkdir(path.join(root, 'sub2'), { recursive: true })
  await writeFile(
    path.join(root, 'a.md'),
    [
      'intro [[b]] text',
      '',
      '```',
      '[[fenced]]',
      '```',
      'self [[#sec]] and [[sub/c]] and [[c]]',
      'missing [[ghost]]',
      'alias [[b|别名]]',
    ].join('\n'),
  )
  await writeFile(path.join(root, 'b.md'), 'B')
  await writeFile(path.join(root, 'sub', 'c.md'), 'C')
  await writeFile(path.join(root, 'd.md'), 'D1')
  await writeFile(path.join(root, 'sub', 'd.md'), 'D2')
  await writeFile(path.join(root, 'sub2', 'e.md'), 'E [[d]]')
  return root
}

describe('parseWikiInner（与 src/wikilink.ts 同构）', () => {
  test('三件套切分', () => {
    expect(wikilinks.parseWikiInner('Note#sec|alias')).toEqual({
      target: 'Note',
      alias: 'alias',
      heading: 'sec',
    })
    expect(wikilinks.parseWikiInner(' 笔记 ')).toEqual({
      target: '笔记',
      alias: '',
      heading: '',
    })
  })
})

describe('scanWikiLinks', () => {
  test('枚举笔记、解析链接、围栏跳过、三档解析', async () => {
    const root = await makeVault()
    const result = await wikilinks.scanWikiLinks([root])

    expect(result.truncated).toBe(false)
    expect(result.notes).toHaveLength(6)

    const aLinks = result.links.filter((l) => l.source.endsWith('a.md'))
    // 围栏里的 [[fenced]] 被跳过，其余 6 处全部收录
    expect(aLinks).toHaveLength(6)
    expect(aLinks.some((l) => l.target === 'fenced')).toBe(false)

    const byTarget = new Map(aLinks.map((l) => [l.target + '#' + l.heading, l]))
    // 同目录同名档
    expect(byTarget.get('b#')?.resolved).toEqual({ kind: 'ok', path: path.join(root, 'b.md') })
    // 相对路径档
    expect(byTarget.get('sub/c#')?.resolved).toEqual({
      kind: 'ok',
      path: path.join(root, 'sub', 'c.md'),
    })
    // 全工作区唯一名档（跨目录命中）
    expect(byTarget.get('c#')?.resolved).toEqual({
      kind: 'ok',
      path: path.join(root, 'sub', 'c.md'),
    })
    // 未找到
    expect(byTarget.get('ghost#')?.resolved).toEqual({ kind: 'missing' })
    // 自文档（空 target）
    expect(byTarget.get('#sec')?.resolved).toEqual({ kind: 'ok', path: path.join(root, 'a.md') })
    // 别名与行号随边携带（[[b]] 出现两处，按出现处分别断言）
    const bAliased = aLinks.find((l) => l.target === 'b' && l.alias === '别名')
    expect(bAliased?.line).toBe(8)
    const bPlain = aLinks.find((l) => l.target === 'b' && !l.alias)
    expect(bPlain?.line).toBe(1)

    // 多同名 → ambiguous（来自无同名文件的 sub2/e.md）
    const eLink = result.links.find((l) => l.source.endsWith('sub2' + path.sep + 'e.md'))
    expect(eLink?.resolved).toEqual({
      kind: 'ambiguous',
      paths: expect.arrayContaining([path.join(root, 'd.md'), path.join(root, 'sub', 'd.md')]),
    })
  })

  test('空根目录返回空结果', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tmd-wiki-empty-'))
    tmpDirs.push(root)
    const result = await wikilinks.scanWikiLinks([root])
    expect(result.notes).toEqual([])
    expect(result.links).toEqual([])
  })
})
