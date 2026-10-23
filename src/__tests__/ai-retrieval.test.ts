import { describe, it, expect } from 'vitest'
import {
  chunkMarkdown,
  cosineSimilarity,
  keywordScore,
  retrieveWorkspaceContext,
  tokenizeQuery,
} from '../ai-retrieval'

/**
 * 工作区检索的纯逻辑：检索词切分、关键词计分、分块、相似度，
 * 以及渲染层无壳层 API 时的空结果降级。
 */

describe('tokenizeQuery', () => {
  it('拉丁词保留 ≥2 字符并小写化', () => {
    expect(tokenizeQuery('Use ProseMirror and API')).toEqual(['use', 'prosemirror', 'and', 'api'])
  })

  it('中日韩连续段拆二元组，短段保留整词', () => {
    expect(tokenizeQuery('向量检索')).toEqual(['向量', '量检', '检索'])
    expect(tokenizeQuery('图表')).toEqual(['图表'])
  })

  it('去重保序，混合文本两侧各自切分', () => {
    const tokens = tokenizeQuery('mermaid 图表渲染 mermaid')
    expect(tokens).toEqual(['mermaid', '图表', '表渲', '渲染'])
  })
})

describe('keywordScore', () => {
  it('按命中次数累加，无命中为 0', () => {
    expect(keywordScore(['mermaid'], 'mermaid 渲染 mermaid')).toBe(2)
    expect(keywordScore(['图表', '渲染'], '图表渲染')).toBe(2)
    expect(keywordScore(['不存在'], '正文')).toBe(0)
  })

  it('空检索词得 0 分（空查询不产生候选）', () => {
    expect(keywordScore([], '任意文本')).toBe(0)
  })
})

describe('chunkMarkdown', () => {
  it('按空行分段并合并到目标大小', () => {
    const chunks = chunkMarkdown('第一段。\n\n第二段。\n\n第三段。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('第一段。')
    expect(chunks[0]).toContain('第三段。')
  })

  it('标题开启新块（片段边界贴合章节）', () => {
    const chunks = chunkMarkdown('引言文字。\n\n## 章节 A\n\nA 的内容。\n\n## 章节 B\n\nB 的内容。')
    expect(chunks).toHaveLength(3)
    expect(chunks[1].startsWith('## 章节 A')).toBe(true)
    expect(chunks[2].startsWith('## 章节 B')).toBe(true)
  })

  it('无空行的超长段落按上限硬切', () => {
    const long = '字'.repeat(3000)
    const chunks = chunkMarkdown(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1200)
  })

  it('空内容返回空数组', () => {
    expect(chunkMarkdown('   \n\n  ')).toEqual([])
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1，正交为 0', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('维度不一致或零向量兜底为 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('retrieveWorkspaceContext 降级', () => {
  it('无壳层 API（浏览器环境）返回空结果而非抛错', async () => {
    const result = await retrieveWorkspaceContext('任意问题', true)
    expect(result).toEqual({ chunks: [], mode: 'keywords' })
  })
})
