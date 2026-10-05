/**
 * 双链索引的扫描与解析逻辑。
 *
 * 独立成模块（不依赖 Electron）：与 search.cjs 同构——文件枚举直接复用其
 * collectSearchFiles（跳过依赖目录 / 受限并发 / 文件数上限），本模块只做
 * .md 过滤、wikilink 逐行解析（跳过围栏代码块）与目标解析。
 *
 * 解析顺序（与 Obsidian 习惯对齐）：
 * ① 含 / 的 target 按 source 所在目录做相对路径解析（支持 ../）
 * ② 同目录同名（.md 可省略）
 * ③ 全工作区文件名（去扩展名、大小写不敏感）唯一匹配
 * ④ 多个同名 → ambiguous（交 UI 呈现）
 * [[#标题]]（空 target）解析为自身文档。
 *
 * 已知边界：行级正则不识别行内代码中的 [[..]]（与 search.cjs 的行级口径
 * 一致）；围栏代码块（``` / ~~~）整体跳过。
 *
 * 注意：parseWikiInner 与 src/wikilink.ts 的同名函数为两侧同构实现
 * （CJS 模块不能 import TS），改动需两处同步。
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')
const { collectSearchFiles, SEARCH_MAX_FILES } = require('./search.cjs')

/** 笔记文件（仅扫描 .md） */
const NOTE_RE = /\.md$/i
/** 单文件内容上限（与 search.cjs 的单文件上限一致） */
const MAX_FILE_SIZE = 2 * 1024 * 1024
/** 文件读取的并发批大小 */
const SCAN_CONCURRENCY = 8
/** 预览行文本的最大长度 */
const PREVIEW_LEN = 200

/** wikilink 行级匹配（内容不允许 [ ] 与换行；\[ 类内无需转义） */
const WIKI_LINE_RE = /\[\[([^[\\\]\n]+)\]\]/g

/**
 * 解析 [[...]] 内部文本：第一个 | 切别名，| 前第一个 # 切标题，各段 trim。
 * @param {string} inner
 * @returns {{ target: string, alias: string, heading: string }}
 */
function parseWikiInner(inner) {
  const pipe = inner.indexOf('|')
  const main = pipe === -1 ? inner : inner.slice(0, pipe)
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
  const hash = main.indexOf('#')
  const target = (hash === -1 ? main : main.slice(0, hash)).trim()
  const heading = hash === -1 ? '' : main.slice(hash + 1).trim()
  return { target, alias, heading }
}

/**
 * 扫描单个笔记文件中的 wikilink 出现处（围栏块内跳过）。
 * @param {string} filePath
 * @returns {Promise<{ target: string, alias: string, heading: string, line: number, text: string }[] | null>}
 *   文件不可读 / 超大 / 二进制时返回 null
 */
async function scanFileLinks(filePath) {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat || stat.size > MAX_FILE_SIZE) return null
  let content
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
  if (content.includes('\0')) return null
  const targets = []
  // 围栏状态：null 在围栏外，否则记录围栏字符（` 或 ~）——闭合须同字符
  let fence = null
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(text)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!fence) fence = ch
      else if (ch === fence) fence = null
      continue
    }
    if (fence) continue
    for (const m of text.matchAll(WIKI_LINE_RE)) {
      const parts = parseWikiInner(m[1])
      if (!parts.target && !parts.heading) continue
      targets.push({
        target: parts.target,
        alias: parts.alias,
        heading: parts.heading,
        line: i + 1,
        text: text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text,
      })
    }
  }
  return targets
}

/**
 * 构建解析索引：全路径（小写键）→ 规范路径；文件名（去 .md，小写键）→ 路径列表。
 * @param {string[]} notes
 */
function buildIndex(notes) {
  /** @type {Map<string, string>} */
  const byPath = new Map()
  /** @type {Map<string, string[]>} */
  const byName = new Map()
  for (const note of notes) {
    byPath.set(note.toLowerCase(), note)
    const key = path.basename(note).replace(/\.md$/i, '').toLowerCase()
    const list = byName.get(key)
    if (list) list.push(note)
    else byName.set(key, [note])
  }
  return { byPath, byName }
}

/**
 * 解析一个 wikilink target 为绝对路径（三个匹配档位，见文件头注释）。
 * @param {string} target
 * @param {string} sourcePath - 链接所在文档（相对路径/同目录档位的基准）
 * @param {ReturnType<typeof buildIndex>} index
 * @returns {{ kind: 'ok', path: string } | { kind: 'ambiguous', paths: string[] } | { kind: 'missing' }}
 */
function resolveTarget(target, sourcePath, index) {
  const t = target.trim()
  // 空目标（[[#标题]]）= 自身文档
  if (!t) return { kind: 'ok', path: sourcePath }
  const withMd = /\.md$/i.test(t) ? t : `${t}.md`
  if (/[/\\]/.test(t)) {
    // 相对路径档：按 source 所在目录解析（target 可含子目录与 ../）
    const joined = path.join(path.dirname(sourcePath), withMd)
    const hit = index.byPath.get(joined.toLowerCase())
    return hit ? { kind: 'ok', path: hit } : { kind: 'missing' }
  }
  // 同目录同名档
  const sameDir = index.byPath.get(path.join(path.dirname(sourcePath), withMd).toLowerCase())
  if (sameDir) return { kind: 'ok', path: sameDir }
  // 全工作区文件名唯一匹配档
  const list = index.byName.get(path.basename(t).replace(/\.md$/i, '').toLowerCase())
  if (!list || list.length === 0) return { kind: 'missing' }
  if (list.length === 1) return { kind: 'ok', path: list[0] }
  return { kind: 'ambiguous', paths: list }
}

/**
 * 扫描工作区全部笔记的 wikilink：一次遍历产出节点（notes）与链接边
 * （links，含逐处解析结果），反向链接面板与关系图谱共用。
 * @param {string[]} roots - 工作区根目录（绝对路径）
 * @param {number} [limit] - 文件数上限
 * @returns {Promise<{
 *   notes: { path: string, name: string }[],
 *   links: { source: string, target: string, alias: string, heading: string, line: number, text: string, resolved: { kind: 'ok', path: string } | { kind: 'ambiguous', paths: string[] } | { kind: 'missing' } }[],
 *   truncated: boolean
 * }>}
 */
async function scanWikiLinks(roots, limit = SEARCH_MAX_FILES) {
  const collected = await collectSearchFiles(roots, limit)
  /** @type {string[]} */
  const notes = collected.files.filter((/** @type {string} */ f) => NOTE_RE.test(f))
  const index = buildIndex(notes)

  // 受限并发逐文件扫描（collectSearchFiles 的并发在其内部，此处对读盘同理）
  const perFile = new Map()
  let cursor = 0
  const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, notes.length) }, async () => {
    while (cursor < notes.length) {
      const file = notes[cursor++]
      perFile.set(file, await scanFileLinks(file))
    }
  })
  await Promise.all(workers)

  const links = []
  for (const source of notes) {
    const targets = perFile.get(source)
    if (!targets) continue
    for (const t of targets) {
      links.push({ source, ...t, resolved: resolveTarget(t.target, source, index) })
    }
  }
  return {
    notes: notes.map((/** @type {string} */ p) => ({ path: p, name: path.basename(p) })),
    links,
    truncated: collected.truncated,
  }
}

module.exports = { scanWikiLinks, resolveTarget, parseWikiInner, buildIndex }
