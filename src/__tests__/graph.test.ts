/**
 * 关系图谱纯函数单元测试：文件夹着色 / 搜索过滤 / 幽灵目标收集 / 图数据构建
 * （节点 + 幽灵 + 边合并 + 自引排除，见 src/graph.ts buildGraphData）
 */
import { describe, expect, test } from 'vitest'
import {
  buildGraphData,
  collectGhostTargets,
  folderColorFor,
  GRAPH_PALETTE,
  matchesQuery,
} from '../graph'
import type { WikiLinkRef } from '../native'

/** 构造一条扫描链接（source/target/解析结果） */
function link(source: string, target: string, resolved: WikiLinkRef['resolved']): WikiLinkRef {
  return { source, target, heading: '', alias: '', line: 1, text: '', resolved }
}

const NOTES = [
  { path: '/w/笔记A.md', name: '笔记A.md' },
  { path: '/w/笔记B.md', name: '笔记B.md' },
]

describe('folderColorFor 按文件夹着色', () => {
  const roots = ['/w/工作区1', '/w/工作区2']

  test('落在第 i 个根之下 → 色板第 i % len 色', () => {
    expect(folderColorFor('/w/工作区1/a.md', roots, true)).toBe(GRAPH_PALETTE[0])
    expect(folderColorFor('/w/工作区1/sub/b.md', roots, true)).toBe(GRAPH_PALETTE[0])
    expect(folderColorFor('/w/工作区2/c.md', roots, true)).toBe(GRAPH_PALETTE[1])
  })

  test('超出色板长度循环取色', () => {
    expect(folderColorFor('/w/工作区2/../工作区1/../工作区2/x.md', roots, true)).toBe(
      GRAPH_PALETTE[1],
    )
  })

  test('不属任何根 → null（调用方用前景色）', () => {
    expect(folderColorFor('/elsewhere/a.md', roots, true)).toBeNull()
  })

  test('功能关闭 → null', () => {
    expect(folderColorFor('/w/工作区1/a.md', roots, false)).toBeNull()
  })
})

describe('matchesQuery 搜索过滤', () => {
  test('空 query 全匹配', () => {
    expect(matchesQuery('任意', '/w/a.md', '')).toBe(true)
    expect(matchesQuery('任意', '/w/a.md', '  ')).toBe(true)
  })

  test('笔记名或路径子串命中（大小写不敏感）', () => {
    expect(matchesQuery('笔记A', '/w/笔记A.md', '笔记')).toBe(true)
    expect(matchesQuery('Note', '/w/Note.md', 'note')).toBe(true)
    expect(matchesQuery('x', '/w/Deep/Dir/Note.md', 'deep/dir')).toBe(true)
  })

  test('未命中 → false', () => {
    expect(matchesQuery('Note', '/w/Note.md', '不存在')).toBe(false)
  })
})

describe('collectGhostTargets 未解析目标收集', () => {
  test('去重保序、跳过命中与空目标', () => {
    const links = [
      link('/w/a.md', '存在', { kind: 'ok', path: '/w/存在.md' }),
      link('/w/a.md', '缺1', { kind: 'missing' }),
      link('/w/a.md', '缺1', { kind: 'missing' }),
      link('/w/a.md', '', { kind: 'missing' }),
      link('/w/a.md', '歧义', { kind: 'ambiguous', paths: ['/w/1.md', '/w/2.md'] }),
    ]
    expect(collectGhostTargets(links)).toEqual(['缺1', '歧义'])
  })
})

describe('buildGraphData 图数据构建', () => {
  const links: WikiLinkRef[] = [
    link('/w/笔记A.md', '笔记B', { kind: 'ok', path: '/w/笔记B.md' }),
    link('/w/笔记A.md', '笔记B', { kind: 'ok', path: '/w/笔记B.md' }),
    link('/w/笔记A.md', '笔记A', { kind: 'ok', path: '/w/笔记A.md' }),
    link('/w/笔记A.md', '待写', { kind: 'missing' }),
  ]

  test('节点含笔记与幽灵，自引不成边，同对合并计重', () => {
    const { nodes, edges } = buildGraphData(NOTES, links, { showGhosts: true })
    // 笔记A + 笔记B + 幽灵「待写」
    expect(nodes).toHaveLength(3)
    const ghost = nodes.find((n) => n.ghost)
    expect(ghost?.label).toBe('待写')
    // 自引被排除：A—B 合并为 1 条、weight=2；A—幽灵 1 条
    expect(edges).toHaveLength(2)
    const ab = edges.find((e) => e.weight === 2)
    expect(ab).toBeDefined()
    expect((ab!.source as { id: string }).id).toBe('/w/笔记A.md')
    expect((ab!.target as { id: string }).id).toBe('/w/笔记B.md')
  })

  test('showGhosts=false 时幽灵不入图', () => {
    const { nodes, edges } = buildGraphData(NOTES, links, { showGhosts: false })
    expect(nodes.some((n) => n.ghost)).toBe(false)
    expect(edges.every((e) => (e.target as { ghost?: boolean }).ghost !== true)).toBe(true)
  })
})
