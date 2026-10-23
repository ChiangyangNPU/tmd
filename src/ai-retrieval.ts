/**
 * 工作区检索（AI 问答的 RAG 上下文源）。
 *
 * 数据源是「已挂载的文件夹」（与全文搜索同一工作区概念）：渲染层递归列目录、
 * 读文档、切块，主进程只负责向量嵌入（与对话同一套 OpenAI 兼容端点）。
 *
 * 两级检索策略：
 * 1. 关键词预筛（本地零网络）：拉丁词（≥2 字符）+ 中日韩二元组命中计数
 * 2. 配置了向量模型时，对预筛候选块做 embedding 重排（余弦相似度）；
 *    嵌入失败（网络 / 配额 / 维度异常）静默回退关键词序，问答不中断
 *
 * 体积防护：目录深度、文件数、单文件字符数、候选块数、送出片段数与片段长度
 * 均有上限，避免把整棵目录树塞进内存或提示词。
 *
 * @author chiangyang
 */
import { native } from './native'
import { folderList } from './store'

/** 检索结果片段：path 供模型引用，text 为裁剪后的原文 */
export interface WorkspaceChunk {
  path: string
  name: string
  text: string
}

/** 检索结果：chunks 按相关性降序；mode 标注实际生效的档位（供界面展示） */
export interface RetrievalResult {
  chunks: WorkspaceChunk[]
  mode: 'embeddings' | 'keywords'
}

/** 参与检索的文件数上限 */
const MAX_FILES = 40
/** 单文件参与检索的内容上限（字符） */
const MAX_FILE_CHARS = 20_000
/** 目录递归深度上限 */
const MAX_DEPTH = 6
/** 关键词预筛保留的候选块数（也是嵌入请求的体积上界） */
const KEYWORD_CANDIDATES = 40
/** 最终送入提问的片段数 */
const TOP_K = 4
/** 切块目标大小（字符） */
const CHUNK_TARGET = 700
/** 单块硬上限（字符）：无空行的超长段落按此硬切 */
const CHUNK_MAX = 1200
/** 送出的单个片段再裁到该上限（提示词体积控制） */
const EXCERPT_MAX = 900
/** 嵌入缓存条目上限（超出整体清空：会话级缓存，重建成本低） */
const EMBED_CACHE_MAX = 2000

/**
 * 把查询拆成检索词：拉丁词保留 ≥2 字符，中日韩连续段拆二元组（单字词检索
 * 噪声大，二元组是未分词场景的常规做法）；去重保序。
 * @param query - 用户提问原文
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []
  const lower = query.toLowerCase()
  for (const word of lower.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    if (word.length >= 2) tokens.push(word)
  }
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length <= 2) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2))
  }
  return [...new Set(tokens)]
}

/**
 * 关键词命中计数（块文本小写化后逐词统计，单词命中封顶防单块刷分）。
 * @param tokens - tokenizeQuery 的输出
 * @param text - 候选块文本
 */
export function keywordScore(tokens: string[], text: string): number {
  if (!tokens.length) return 0
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    let idx = lower.indexOf(token)
    let hits = 0
    while (idx !== -1 && hits < 20) {
      hits++
      idx = lower.indexOf(token, idx + token.length)
    }
    score += hits
  }
  return score
}

/**
 * 把 Markdown 切成检索块：优先按空行分段，标题开新块（片段边界贴合文档
 * 结构），相邻段拼到目标大小；无空行的超长段落按 CHUNK_MAX 硬切。
 * @param text - 文档原文（frontmatter 原样参与，其中字段名也是可检索信号）
 */
export function chunkMarkdown(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  const chunks: string[] = []
  let buffer = ''
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim())
    buffer = ''
  }
  for (const para of clean.split(/\n{2,}/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    // 标题自成一块的起点：回答引用片段时更容易对齐到章节
    if (/^#{1,6}\s/.test(trimmed)) flush()
    if (buffer && buffer.length + trimmed.length + 2 > CHUNK_TARGET) flush()
    buffer += (buffer ? '\n\n' : '') + trimmed
    if (buffer.length >= CHUNK_MAX) flush()
  }
  flush()
  const out: string[] = []
  for (const chunk of chunks) {
    if (chunk.length <= CHUNK_MAX) {
      out.push(chunk)
      continue
    }
    for (let i = 0; i < chunk.length; i += CHUNK_MAX) out.push(chunk.slice(i, i + CHUNK_MAX))
  }
  return out
}

/**
 * 余弦相似度；维度不一致或零向量返回 0（上游返回异常向量时的兜底）。
 * @param a - 查询向量
 * @param b - 候选向量
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 递归列出工作区内的文本文档（readDir 已按扩展名过滤，这里再排除隐藏
 * 目录并施加深度/数量上限）。
 * @param roots - 已挂载文件夹的根路径
 */
export async function collectWorkspaceFiles(
  roots: string[],
): Promise<Array<{ path: string; name: string }>> {
  const api = native
  if (!api) return []
  const readDir = api.readDir.bind(api)
  const files: Array<{ path: string; name: string }> = []
  const seen = new Set<string>()
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let res
    try {
      res = await readDir(dir)
    } catch {
      return
    }
    if (!res) return
    for (const entry of res.children ?? []) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.')) continue
      if (entry.children) {
        await walk(entry.path, depth + 1)
      } else if (!seen.has(entry.path)) {
        seen.add(entry.path)
        files.push({ path: entry.path, name: entry.name })
      }
    }
  }
  for (const root of roots) await walk(root, 0)
  return files
}

/** 嵌入缓存：块文本 → 向量（内容变更自然换键；会话级，问答面板常驻复用） */
const embeddingCache = new Map<string, number[]>()

/**
 * 嵌入一批文本（走缓存）；任一失败抛错，由调用方整体回退。
 * @param texts - 待嵌入文本
 */
async function embedTexts(texts: string[]): Promise<number[][]> {
  const missing = texts.filter((t) => !embeddingCache.has(t))
  if (missing.length) {
    const result = await native!.embedAiTexts(missing)
    if (!result.ok) throw new Error(result.error.message)
    for (let i = 0; i < missing.length; i++) embeddingCache.set(missing[i], result.vectors[i])
    if (embeddingCache.size > EMBED_CACHE_MAX) embeddingCache.clear()
  }
  return texts.map((t) => embeddingCache.get(t)!)
}

/** 取相关性降序的前 K 个非零分块，并裁剪送出长度 */
function pickTopK(scored: Array<{ chunk: WorkspaceChunk; score: number }>): WorkspaceChunk[] {
  return scored
    .filter((item) => item.score > 0)
    .slice(0, TOP_K)
    .map((item) => ({
      ...item.chunk,
      text:
        item.chunk.text.length > EXCERPT_MAX
          ? item.chunk.text.slice(0, EXCERPT_MAX)
          : item.chunk.text,
    }))
}

/**
 * 检索与提问相关的工作区片段。
 * @param query - 用户提问
 * @param useEmbeddings - 是否启用向量重排（调用方按 embedModel 是否配置决定）
 */
export async function retrieveWorkspaceContext(
  query: string,
  useEmbeddings: boolean,
): Promise<RetrievalResult> {
  if (!native?.readFile) return { chunks: [], mode: 'keywords' }
  const roots = folderList().map((f) => f.path)
  if (!roots.length) return { chunks: [], mode: 'keywords' }
  const files = await collectWorkspaceFiles(roots)
  if (!files.length) return { chunks: [], mode: 'keywords' }

  // 读取 + 切块（读盘失败的文件跳过，不让单个坏文件中断检索）
  const scored: Array<{ chunk: WorkspaceChunk; score: number }> = []
  for (const file of files) {
    let content: string
    try {
      content = (await native.readFile(file.path)).content
    } catch {
      continue
    }
    if (!content.trim()) continue
    const text = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content
    for (const piece of chunkMarkdown(text)) {
      scored.push({ chunk: { path: file.path, name: file.name, text: piece }, score: 0 })
    }
  }
  if (!scored.length) return { chunks: [], mode: 'keywords' }

  // 第一级：关键词预筛（零网络，同时充当嵌入档的候选生成器）
  const tokens = tokenizeQuery(query)
  for (const item of scored) item.score = keywordScore(tokens, item.chunk.text)
  scored.sort((a, b) => b.score - a.score)
  const candidates = scored.slice(0, KEYWORD_CANDIDATES)

  // 第二级：向量重排（仅对候选块与查询本身做嵌入，体积有界）。
  // 嵌入调用缺失/失败（网络、配额、旧版桥接）都走 catch 回退关键词序
  if (useEmbeddings) {
    try {
      const [queryVec, ...chunkVecs] = await embedTexts([
        query,
        ...candidates.map((c) => c.chunk.text),
      ])
      for (let i = 0; i < candidates.length; i++) {
        candidates[i].score = cosineSimilarity(queryVec, chunkVecs[i])
      }
      candidates.sort((a, b) => b.score - a.score)
      return { chunks: pickTopK(candidates), mode: 'embeddings' }
    } catch {
      // 嵌入不可用（网络 / 配额 / 未配置）：关键词序兜底，问答不中断
    }
  }
  return { chunks: pickTopK(candidates), mode: 'keywords' }
}
