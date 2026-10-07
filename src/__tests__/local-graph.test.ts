/**
 * 局部图谱纯函数单元测试：出链实时解析（parseOutTargets，围栏跳过）与
 * 邻域收集（collectNeighborhood：一跳/二跳、幽灵节点、去重、自引排除）
 */
import { describe, expect, test } from 'vitest'
import { collectNeighborhood, parseOutTargets } from '../local-graph'
import type { WikiLinkRef, WikiResolvedLink } from '../native'

describe('parseOutTargets 出链实时解析', () => {
  test('提取 target（别名/标题锚归一为 target）并去重', () => {
    expect(parseOutTargets('见 [[B]] 与 [[B|别名]] 与 [[C#章]]')).toEqual(['B', 'C'])
  })

  test('围栏代码块内跳过', () => {
    const md = '[[A]]\n\n```\n[[B]]\n```\n\n~~~\n[[C]]\n~~~\n\n[[D]]'
    expect(parseOutTargets(md)).toEqual(['A', 'D'])
  })

  test('空目标不成条目', () => {
    expect(parseOutTargets('a [[]] b')).toEqual([])
  })
})

describe('collectNeighborhood 邻域收集', () => {
  const cur = '/w/A.md'
  const b = '/w/B.md'
  const c = '/w/C.md'

  const link = (source: string, target: string, resolved: WikiResolvedLink): WikiLinkRef => ({
    source,
    target,
    heading: '',
    alias: '',
    line: 1,
    text: '',
    resolved,
  })

  test('一跳：出链（命中）+ 入链（反链）', () => {
    const links = [link(cur, 'B', { kind: 'ok', path: b }), link(c, 'A', { kind: 'ok', path: cur })]
    const { nodes, edges } = collectNeighborhood(cur, links, [], 1)
    expect(nodes.has(b)).toBe(true)
    expect(nodes.has(c)).toBe(true)
    expect(nodes.has(cur)).toBe(false) // 中心节点不在邻居集合
    expect(edges.some(([f, t]) => new Set([f, t]).has(b) && new Set([f, t]).has(cur))).toBe(true)
  })

  test('未命中的出链 → 幽灵节点', () => {
    const liveOut = [{ target: '待写', resolved: { kind: 'missing' as const } }]
    const { nodes } = collectNeighborhood(cur, [], liveOut, 1)
    expect(nodes.get('ghost:待写')?.ghost).toBe(true)
  })

  test('命中的实时出链连到真实节点', () => {
    const liveOut = [{ target: 'B', resolved: { kind: 'ok' as const, path: b } }]
    const { nodes } = collectNeighborhood(cur, [], liveOut, 1)
    expect(nodes.get(b)?.ghost).toBe(false)
  })

  test('二跳扩展 + 去重', () => {
    // A→B（一跳出链），B→C（二跳扩展）
    const links = [link(cur, 'B', { kind: 'ok', path: b }), link(b, 'C', { kind: 'ok', path: c })]
    const d1 = collectNeighborhood(cur, links, [], 1)
    expect(d1.nodes.has(c)).toBe(false)
    const d2 = collectNeighborhood(cur, links, [], 2)
    expect(d2.nodes.has(c)).toBe(true)
    // 边去重：A—B 只一条
    const abEdges = d2.edges.filter(([f, t]) => new Set([f, t]).has(b) && new Set([f, t]).has(cur))
    expect(abEdges).toHaveLength(1)
  })
})
