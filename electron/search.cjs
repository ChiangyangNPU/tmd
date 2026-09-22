/**
 * 跨文件全文搜索的扫描与匹配逻辑。
 *
 * 独立成模块（不依赖 Electron）：主进程的 IPC handler 只做参数校验与结果包装，
 * 扫描/匹配这部分纯 Node 逻辑可被独立验证。
 *
 * 保护措施（避免在大型工作区上长时间占用主进程）：
 * - 跳过依赖目录与隐藏项（SEARCH_SKIP_DIRS）
 * - 单文件大小上限（SEARCH_MAX_FILE_SIZE），超过视为非文本
 * - 扫描文件数上限（SEARCH_MAX_FILES）与命中行数上限（SEARCH_MAX_MATCHES）
 * - 目录读取用受限并发（SEARCH_CONCURRENCY），不做全量并发
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')

/** 搜索时跳过的目录名（依赖 / 版本库 / 构建产物） */
const SEARCH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'release',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
  'vendor',
])

/** 搜索收录的文件扩展名（纯文本类，避免把二进制当文本读） */
const SEARCH_EXT_RE =
  /\.(md|markdown|mdx|txt|text|json|ya?ml|toml|ini|csv|log|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|bat|ps1|sql|tex)$/i

/** 单文件大小上限（字节） */
const SEARCH_MAX_FILE_SIZE = 2 * 1024 * 1024
/** 单次搜索扫描的文件数上限 */
const SEARCH_MAX_FILES = 5000
/** 单次搜索返回的命中行数上限 */
const SEARCH_MAX_MATCHES = 500
/** 预览行文本的最大长度（超出截断） */
const SEARCH_PREVIEW_LEN = 200
/** 目录读取的并发批大小 */
const SEARCH_CONCURRENCY = 8

/**
 * 广度优先收集根目录下可搜索的文本文件。
 * @param {string[]} roots - 搜索根目录（绝对路径）
 * @param {number} limit - 文件数上限
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
async function collectSearchFiles(roots, limit = SEARCH_MAX_FILES) {
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const queue = [...roots]
  let truncated = false
  while (queue.length) {
    if (files.length >= limit) {
      truncated = true
      break
    }
    const batch = queue.splice(0, SEARCH_CONCURRENCY)
    const listings = await Promise.all(
      batch.map(async (dir) => {
        try {
          return await fs.readdir(dir, { withFileTypes: true })
        } catch {
          // 权限不足或目录已删除：跳过
          return []
        }
      }),
    )
    for (let i = 0; i < batch.length; i++) {
      for (const entry of listings[i]) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(batch[i], entry.name)
        if (entry.isDirectory()) {
          if (!SEARCH_SKIP_DIRS.has(entry.name)) queue.push(full)
        } else if (entry.isFile() && SEARCH_EXT_RE.test(entry.name)) {
          if (files.length < limit) files.push(full)
          else truncated = true
        }
      }
    }
  }
  return { files, truncated }
}

/**
 * 在给定文件中逐行搜索关键词（大小写不敏感，一行最多产出一条命中）。
 *
 * `occurrence` 为该行首个匹配在文件内的序号（1 起），渲染层据此在同文档内
 * 用 findMatches 重新匹配后精确定位——源文本行号与 ProseMirror 位置不可换算。
 *
 * @param {string[]} files - 待搜索文件
 * @param {string} needle - 已转小写的关键词
 * @param {number} limit - 命中行数上限
 * @returns {Promise<{matches: import('../src/native.ts').SearchMatch[], fileCount: number, truncated: boolean}>}
 */
async function searchInFiles(files, needle, limit = SEARCH_MAX_MATCHES) {
  /** @type {import('../src/native.ts').SearchMatch[]} */
  const matches = []
  let fileCount = 0
  let truncated = false
  for (const file of files) {
    if (matches.length >= limit) {
      truncated = true
      break
    }
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      continue
    }
    if (stat.size > SEARCH_MAX_FILE_SIZE) continue
    let content
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    // 二进制嗅探：前 4KB 含 NUL 字节即视为非文本
    if (content.slice(0, 4096).includes('\0')) continue

    const lines = content.split(/\r?\n/)
    /** 该文件内已出现的匹配总数 */
    let occurrence = 0
    let hitInFile = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lower = line.toLowerCase()
      const first = lower.indexOf(needle)
      if (first === -1) continue
      // 统计本行出现次数：首匹配作为本行结果，其余仅推进 occurrence 供后续行对齐
      let count = 0
      let cursor = first
      while (cursor !== -1) {
        count++
        cursor = lower.indexOf(needle, cursor + needle.length)
      }
      if (matches.length >= limit) {
        truncated = true
        break
      }
      occurrence += 1
      matches.push({
        path: file,
        name: path.basename(file),
        line: i + 1,
        column: first + 1,
        occurrence,
        text: line.length > SEARCH_PREVIEW_LEN ? `${line.slice(0, SEARCH_PREVIEW_LEN)}…` : line,
      })
      hitInFile = true
      occurrence += count - 1
    }
    if (hitInFile) fileCount++
  }
  return { matches, fileCount, truncated }
}

module.exports = {
  collectSearchFiles,
  searchInFiles,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES,
}
