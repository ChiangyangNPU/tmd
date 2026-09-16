/**
 * 跨文件全文搜索面板
 *
 * 数据源是「已挂载的文件夹」（多文件夹工作区）：搜索在主进程执行
 * （渲染层无 Node 权限，且大目录扫描不能阻塞 UI），本模块负责收集根目录、
 * 驱动输入防抖、渲染结果并跳转。
 *
 * 交互沿用快速切换面板的范式：Ctrl/Cmd+Shift+F 唤起、↑↓ 选择、回车打开、
 * Esc 关闭（Esc 与遮罩点击在 main.ts / wireSearch 分别处理）。
 * 输入 300ms 防抖，并用序号守卫丢弃过期结果——用户连续输入时旧请求可能后到
 * （与 mermaid 渲染的 renderSeq 同一做法）。
 *
 * 定位说明：主进程返回的是「原始 markdown 的行号与文件内序号」，
 * 与编辑器内的实时文档不能直接换算（进入编辑器前内容经过序列化，frontmatter
 * 会被剥离、语法字符不占位，文档还可能已被编辑）。因此打开文件后用关键词在
 * 实时文档内重新匹配，取第 occurrence 个：所见即所得走 findMatches()，
 * 源码模式走 jumpToSourceMatch()；滚动用 scrollEditorPosIntoView()——
 * PM 自带的 scrollIntoView 对 .page-scroll 这个自定义滚动容器无效。
 *
 * @author chiangyang
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { t } from './i18n'
import { native } from './native'
import type { SearchMatch } from './native'
import { activateTab, findByPath } from './tabs'
import { openPath } from './files'
import { folderList } from './store'
import { getPmView, isSourceMode, jumpToSourceMatch } from './editor-core'
import { findMatches } from './find'
import { scrollEditorPosIntoView } from './toc'
import { dirOf, normalizeFsPath } from './fs-path'

/** 输入防抖时长（毫秒）：全文搜索要读盘，比面板内的内存过滤更长 */
const SEARCH_DEBOUNCE_MS = 300

/** 高亮片段：hit 为 true 表示该段命中关键词 */
export interface HighlightSegment {
  text: string
  hit: boolean
}

/**
 * 把一行文本按关键词切成高亮片段（大小写不敏感，纯函数）。
 * @param text - 原始行文本
 * @param query - 关键词；为空时整行作为单个非命中片段
 * @returns 片段数组
 */
export function splitHighlights(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase()
  if (!q) return text ? [{ text, hit: false }] : []
  const lower = text.toLowerCase()
  const out: HighlightSegment[] = []
  let cursor = 0
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    if (idx > cursor) out.push({ text: text.slice(cursor, idx), hit: false })
    out.push({ text: text.slice(idx, idx + q.length), hit: true })
    cursor = idx + q.length
    idx = lower.indexOf(q, cursor)
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}

/** 按文件分组的结果（列表按文件聚合展示） */
export interface SearchFileGroup {
  path: string
  name: string
  dir: string
  matches: SearchMatch[]
}

/**
 * 把扁平命中列表按文件分组（保持首次出现顺序，纯函数）。
 * @param matches - 主进程返回的命中列表
 * @returns 分组结果；目录已规范化为正斜杠便于展示
 */
export function groupMatches(matches: SearchMatch[]): SearchFileGroup[] {
  const map = new Map<string, SearchFileGroup>()
  for (const m of matches) {
    let group = map.get(m.path)
    if (!group) {
      group = { path: m.path, name: m.name, dir: normalizeFsPath(dirOf(m.path)), matches: [] }
      map.set(m.path, group)
    }
    group.matches.push(m)
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// 面板状态
// ---------------------------------------------------------------------------

/** 输入防抖定时器 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
/** 搜索序号：连续输入时丢弃过期结果 */
let searchSeq = 0
/** 最近一次查询（定位与高亮复用） */
let lastQuery = ''
/** 扁平化的命中列表（与渲染顺序一致，供键盘导航索引） */
let flatMatches: SearchMatch[] = []
/** 当前选中项索引 */
let selected = 0

/** 转义 HTML 特殊字符：命中文本来自磁盘文件，插入 DOM 前必须转义 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 更新面板右侧状态文案 */
function setStatus(text: string) {
  const el = document.getElementById('search-status')
  if (el) el.textContent = text
}

/** 渲染结果列表（按文件分组，命中词高亮，保持选中态） */
function renderResults() {
  const list = document.getElementById('search-list')
  if (!list) return
  const groups = groupMatches(flatMatches)
  if (!groups.length) {
    list.innerHTML = ''
    return
  }
  let index = 0
  list.innerHTML = groups
    .map((group) => {
      const hits = group.matches
        .map((m) => {
          const i = index++
          const segments = splitHighlights(m.text, lastQuery)
            .map((s) => (s.hit ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text)))
            .join('')
          return (
            `<div class="search-hit${i === selected ? ' active' : ''}" data-index="${i}">` +
            `<span class="search-line">${m.line}</span>` +
            `<span class="search-text">${segments}</span>` +
            '</div>'
          )
        })
        .join('')
      return (
        '<div class="search-group">' +
        '<div class="search-file">' +
        `<span class="search-file-name">${escapeHtml(group.name)}</span>` +
        `<span class="search-file-dir">${escapeHtml(group.dir)}</span>` +
        `<span class="search-file-count">${group.matches.length}</span>` +
        `</div>${hits}</div>`
      )
    })
    .join('')
}

/** 移动选中项（循环），并让选中行滚入视野 */
function moveSelection(delta: number) {
  if (!flatMatches.length) return
  selected = (selected + delta + flatMatches.length) % flatMatches.length
  const list = document.getElementById('search-list')
  if (!list) return
  list.querySelectorAll('.search-hit').forEach((el, i) => {
    el.classList.toggle('active', i === selected)
  })
  const active = list.querySelector('.search-hit.active')
  if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' })
}

/** 执行搜索：收集已挂载文件夹作为根目录，结果回来时校验序号防止过期覆盖 */
async function runSearch(rawQuery: string) {
  const query = rawQuery.trim()
  lastQuery = query
  if (!query) {
    flatMatches = []
    selected = 0
    renderResults()
    setStatus('')
    return
  }
  if (!native) {
    setStatus(t('search.unavailable'))
    return
  }
  const roots = folderList().map((f) => f.path)
  if (!roots.length) {
    flatMatches = []
    renderResults()
    setStatus(t('search.noFolder'))
    return
  }
  const seq = ++searchSeq
  setStatus(t('search.searching'))
  const result = await native.searchFiles(roots, query)
  // 期间用户又输入了新的关键词 → 本次结果作废
  if (seq !== searchSeq) return
  flatMatches = result.matches
  selected = 0
  renderResults()
  const summary = t('search.summary', {
    files: result.fileCount,
    hits: result.matches.length,
    ms: result.elapsedMs,
  })
  setStatus(result.truncated ? `${summary}（${t('search.truncated')}）` : summary)
}

/**
 * 在已就绪的编辑器内定位到命中处。
 * 所见即所得与源码模式都按 occurrence 取实时文档内第 N 个匹配；
 * 匹配数不足时退回最后一个（文档已被编辑时行号会漂移）。
 */
function locateMatch(match: SearchMatch, query: string) {
  // 源码模式：CodeMirror 文档内重新匹配定位（同一策略，见 jumpToSourceMatch）
  if (isSourceMode()) {
    jumpToSourceMatch(query, match.occurrence)
    return
  }
  const view = getPmView()
  if (!view) return
  const ranges = findMatches(view.state.doc, query)
  if (!ranges.length) return
  const target = ranges[Math.min(match.occurrence, ranges.length) - 1]
  const selection = TextSelection.create(view.state.doc, target.from, target.to)
  view.dispatch(view.state.tr.setSelection(selection))
  view.focus()
  scrollEditorPosIntoView(view, selection.from)
}

/** 打开当前选中的命中：已打开则切标签，否则读盘打开，随后定位 */
async function openSelected() {
  const match = flatMatches[selected]
  if (!match) return
  const query = lastQuery
  closeSearch()
  const existing = findByPath(match.path)
  if (existing) await activateTab(existing.id)
  else await openPath(match.path)
  // 到此编辑器已是目标文档（openPath / activateTab 内部 await 了编辑器重建）
  locateMatch(match, query)
}

/** 打开搜索面板（Esc / 遮罩点击关闭） */
export function openSearch() {
  const overlay = document.getElementById('search-overlay')
  const input = document.getElementById('search-input') as HTMLInputElement | null
  if (!overlay || !input) return
  overlay.hidden = false
  input.value = ''
  lastQuery = ''
  flatMatches = []
  selected = 0
  renderResults()
  setStatus('')
  input.focus()
}

/** 关闭搜索面板并作废在途搜索 */
export function closeSearch() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  searchSeq++
  document.getElementById('search-overlay')?.setAttribute('hidden', '')
}

/** 搜索面板事件装配（boot 时调用一次） */
export function wireSearch() {
  const overlay = document.getElementById('search-overlay')
  const input = document.getElementById('search-input') as HTMLInputElement | null
  if (!overlay || !input) return

  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void runSearch(input.value), SEARCH_DEBOUNCE_MS)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void openSelected()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    }
  })
  // 点击遮罩空白处关闭（与设置面板、快速切换同一交互）
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSearch()
  })
  document.getElementById('search-list')?.addEventListener('click', (e) => {
    const hit = (e.target as HTMLElement).closest('.search-hit')
    if (!(hit instanceof HTMLElement)) return
    selected = Number(hit.dataset.index ?? 0)
    void openSelected()
  })
}
