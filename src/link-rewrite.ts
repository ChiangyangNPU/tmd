/**
 * 改名时自动重写全工作区引用链接（Obsidian 式行为）。
 *
 * 数据来源：改名前捕获的双链索引快照（preScan）——其中解析命中旧路径
 * （或 ambiguous 包含旧路径）的链接即受影响链接。重写按行进行（围栏块
 * 内跳过），只把 target 段替换为新名，别名/标题锚原样保留；原始 target
 * 带子目录前缀的，按「源目录 → 新路径」重写相对路径并保持原有无 .md
 * 的书写习惯。
 *
 * 写回策略（与外部修改监视的指纹豁免对齐）：
 * - 已打开标签（内存为准）：tab.markdown 文本重写；干净标签同步 saveFile
 *   落盘（noteWrite 指纹豁免，不触发重载提示）保持干净；脏标签不落盘
 *   （待用户保存写回重写后的内存内容）
 * - 活动标签：经 replaceEditor 整体重写编辑器内容（撤销栈重置，属已记录
 *   取舍——双模型架构下对活动文档做局部 PM 事务需区分两侧权威，v1 不做）
 * - 未打开文件：readFile → 重写 → saveFile（不在监视集合，无感，顺带进
 *   历史快照）
 *
 * @author chiangyang
 */
import { replaceEditor } from './editor-core'
import { normalizePath } from './link-nav'
import { native, type WikiLinkRef, type WikiScanResult } from './native'
import { activeTab, findByPath } from './tabs'

/** 行内 wikilink 匹配（与 electron/wikilinks.cjs 同款正则） */
const WIKI_LINE_RE = /\[\[([^[\\\]\n]+)\]\]/g

/** 跨平台 basename（渲染层无 path 模块） */
function baseName(p: string): string {
  const norm = p.replaceAll('\\', '/')
  return norm.slice(norm.lastIndexOf('/') + 1)
}

/** 取目录部分（统一正斜杠） */
function dirOf(p: string): string {
  const norm = p.replaceAll('\\', '/')
  const i = norm.lastIndexOf('/')
  return i > 0 ? norm.slice(0, i) : ''
}

/** from 目录到 to 文件的相对路径（正斜杠；按需 ../ 前缀） */
function relativePath(fromDir: string, toPath: string): string {
  const from = normalizePath(fromDir).split('/').filter(Boolean)
  const to = normalizePath(toPath).split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length && from[i].toLowerCase() === to[i].toLowerCase()) i++
  return [...Array<string>(from.length - i).fill('..'), ...to.slice(i)].join('/')
}

/** 是否受影响链接：解析命中旧路径（或 ambiguous 包含旧路径） */
function pointsToOld(link: WikiLinkRef, oldPath: string): boolean {
  const r = link.resolved
  if (r.kind === 'ok') return r.path === oldPath
  if (r.kind === 'ambiguous') return r.paths.some((p) => p === oldPath)
  return false
}

/**
 * 单文件内容重写：逐行（围栏块内跳过）把 target 指向旧名的 wikilink
 * 替换为新名。返回新内容；无变化返回 null。导出供单测。
 * 候选集合是「preScan 中解析命中旧路径的原始 target 串」，target 按写入
 * 原文（trim 后）精确匹配，避免误改同名但解析到别处的链接。
 */
export function rewriteContent(
  content: string,
  sourcePath: string,
  candidates: WikiLinkRef[],
  oldPath: string,
  newPath: string,
): string | null {
  const candidateTargets = new Set(
    candidates
      .filter((l) => l.source === sourcePath && pointsToOld(l, oldPath))
      .map((l) => l.target.trim().toLowerCase()),
  )
  if (candidateTargets.size === 0) return null

  const newBase = baseName(newPath).replace(/\.md$/i, '')
  const sourceDir = dirOf(sourcePath)

  let fence: string | null = null
  let changed = false
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
    if (fence || !text.includes('[[')) continue
    lines[i] = text.replace(WIKI_LINE_RE, (m: string, inner: string) => {
      // raw 段原样保留（别名 / 标题锚及其间空白），只替换 target 段
      const pipe = inner.indexOf('|')
      const rawMain = pipe === -1 ? inner : inner.slice(0, pipe)
      const hash = rawMain.indexOf('#')
      const rawTarget = (hash === -1 ? rawMain : rawMain.slice(0, hash)).trim()
      const rawSuffix = hash === -1 ? '' : rawMain.slice(hash)
      const rawAlias = pipe === -1 ? '' : inner.slice(pipe)
      if (!candidateTargets.has(rawTarget.toLowerCase())) return m
      const keptMd = /\.md$/i.test(rawTarget)
      const hadSlash = /[/\\]/.test(rawTarget)
      const newTarget = hadSlash
        ? // 相对路径基于「去扩展名」的新路径计算，扩展名按原书写习惯补回
          relativePath(sourceDir, newPath.replace(/\.md$/i, '')) + (keptMd ? '.md' : '')
        : keptMd
          ? `${newBase}.md`
          : newBase
      changed = true
      return `[[${newTarget}${rawSuffix}${rawAlias}]]`
    })
  }
  return changed ? lines.join('\n') : null
}

/**
 * 改名后重写全工作区引用。重写基于改名前捕获的索引快照（preScan）；
 * 返回更新文件数（toast 由调用方呈现）。
 * @param opts.oldPath - 改名前绝对路径
 * @param opts.newPath - 改名后绝对路径
 * @param opts.preScan - 改名前的双链索引快照（renameEntry 在 rename 前捕获）
 */
export async function rewriteLinksForRename(opts: {
  oldPath: string
  newPath: string
  preScan: WikiScanResult
}): Promise<number> {
  if (!native) return 0
  const { oldPath, newPath, preScan } = opts
  const sources = new Set(preScan.links.filter((l) => pointsToOld(l, oldPath)).map((l) => l.source))
  let updated = 0
  for (const source of sources) {
    // 被改名的文件自身的自引（[[#sec]]）target 为空、解析指向自身，
    // 改名后路径已换：重写无意义，跳过
    if (source === oldPath || source === newPath) continue
    const tab = findByPath(source)
    let original: string | null
    if (tab) original = tab.markdown
    else {
      try {
        original = (await native.readFile(source)).content
      } catch {
        continue
      }
    }
    const rewritten = rewriteContent(original, source, preScan.links, oldPath, newPath)
    if (rewritten == null) continue
    try {
      if (tab) {
        tab.markdown = rewritten
        // 活动标签：整体替换编辑器内容（撤销栈重置，属已记录取舍）；
        // 干净标签同步落盘保持干净，脏标签不落盘（待用户保存写回）
        if (activeTab() === tab && !tab.dirty) {
          await replaceEditor(rewritten)
          await native.saveFile(source, rewritten)
        }
      } else {
        await native.saveFile(source, rewritten)
      }
      updated++
    } catch (err) {
      console.error('[tmd] 引用重写失败', source, err)
    }
  }
  return updated
}
