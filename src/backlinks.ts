/**
 * 反向链接面板：列出全工作区引用当前笔记的 [[..]]（按来源文件分组）。
 *
 * 数据来自双链索引（wikilink-index 的按需扫描）：打开面板取最新快照，
 * 打开期间索引刷新（保存 / 改名 / 新建触发的重扫完成）自动重渲染。
 * 点击命中 → 打开来源文档并定位到该链接（关键词用重建的 [[..]] 原文，
 * 找不到时回落 [[目标 前缀，与 search.ts 的 occurrence 定位同一策略）。
 *
 * 面板复用 search-overlay / search-panel 外壳（与 history-panel 同款做法）。
 *
 * @author chiangyang
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { t } from './i18n'
import { getPmView, isSourceMode, jumpToSourceMatch } from './editor-core'
import { findMatches } from './find'
import { activateTab, activeTab, findByPath } from './tabs'
import { openPath } from './files'
import { getWikiLinks, onWikiIndexRefreshed } from './wikilink-index'
import { scrollEditorPosIntoView } from './toc'
import type { WikiLinkRef } from './native'

function setStatus(text: string): void {
  const el = document.getElementById('backlinks-status')
  if (el) el.textContent = text
}

/** 关闭面板 */
export function closeBacklinks(): void {
  document.getElementById('backlinks-overlay')?.setAttribute('hidden', '')
}

/** 打开面板并渲染当前笔记的反向链接 */
export async function openBacklinks(): Promise<void> {
  const overlay = document.getElementById('backlinks-overlay')
  if (!overlay) return
  overlay.hidden = false
  await refreshBacklinks()
}

/** 拉取索引并渲染（打开与索引刷新共用） */
async function refreshBacklinks(): Promise<void> {
  const overlay = document.getElementById('backlinks-overlay')
  if (!overlay || overlay.hidden) return
  const tab = activeTab()
  if (!tab?.path) {
    setStatus(t('backlinks.untitled'))
    renderGroups(new Map())
    return
  }
  setStatus(t('backlinks.loading'))
  const scan = await getWikiLinks()
  // 等待扫描期间面板可能已被切走
  if (!overlay || overlay.hidden || activeTab() !== tab) return
  if (!scan) {
    setStatus(t('backlinks.empty'))
    renderGroups(new Map())
    return
  }
  // 反向链接 = 解析命中当前笔记的引用（排除自身文档的自引）
  const hits = scan.links.filter(
    (l) => l.resolved.kind === 'ok' && l.resolved.path === tab.path && l.source !== tab.path,
  )
  if (scan.truncated) setStatus(t('backlinks.truncated'))
  else if (hits.length === 0) setStatus(t('backlinks.empty'))
  else
    setStatus(
      t('backlinks.summary', {
        count: hits.length,
        files: new Set(hits.map((h) => h.source)).size,
      }),
    )
  renderGroups(groupBySource(hits))
}

/** 按来源文件分组（保持首次出现顺序） */
function groupBySource(hits: WikiLinkRef[]): Map<string, WikiLinkRef[]> {
  const groups = new Map<string, WikiLinkRef[]>()
  for (const hit of hits) {
    const list = groups.get(hit.source)
    if (list) list.push(hit)
    else groups.set(hit.source, [hit])
  }
  return groups
}

/** HTML 转义（与 search.ts 同款） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 当前渲染的命中扁平列表（与 data-index 对齐，点击定位用） */
let flatHits: WikiLinkRef[] = []

/** 渲染分组列表（来源文件 → 命中行） */
function renderGroups(groups: Map<string, WikiLinkRef[]>): void {
  const list = document.getElementById('backlinks-list')
  if (!list) return
  flatHits = [...groups.values()].flat()
  if (groups.size === 0) {
    list.innerHTML = ''
    return
  }
  const parts: string[] = []
  let index = 0
  for (const [source, hits] of groups) {
    const name = source.split(/[\\/]/).pop() ?? source
    parts.push(`<div class="backlinks-file">${escapeHtml(name)}</div>`)
    for (const hit of hits) {
      parts.push(
        `<button class="backlinks-hit" data-index="${index}">` +
          `<span class="backlinks-line-no">${hit.line}</span>` +
          `<span class="backlinks-text">${escapeHtml(hit.text)}</span>` +
          `</button>`,
      )
      index++
    }
  }
  list.innerHTML = parts.join('')
}

/**
 * 定位到链接处：关键词用重建的 [[..]] 原文（别名/标题锚一致），找不到时
 * 回落 [[目标 前缀；源码模式走 jumpToSourceMatch（与搜索面板同策略）。
 */
function locateHit(hit: WikiLinkRef): void {
  const primary = `[[${hit.target}${hit.heading ? `#${hit.heading}` : ''}${hit.alias ? `|${hit.alias}` : ''}]]`
  const fallback = `[[${hit.target}`
  if (isSourceMode()) {
    jumpToSourceMatch(fallback, 1)
    return
  }
  const view = getPmView()
  if (!view) return
  let ranges = findMatches(view.state.doc, primary)
  if (!ranges.length) ranges = findMatches(view.state.doc, fallback)
  if (!ranges.length) return
  const target = ranges[0]
  const selection = TextSelection.create(view.state.doc, target.from, target.to)
  view.dispatch(view.state.tr.setSelection(selection))
  view.focus()
  scrollEditorPosIntoView(view, selection.from)
}

/** 点击命中：打开来源文档（已打开则切标签）后定位 */
async function openHit(hit: WikiLinkRef): Promise<void> {
  closeBacklinks()
  const existing = findByPath(hit.source)
  if (existing) await activateTab(existing.id)
  else await openPath(hit.source)
  locateHit(hit)
}

/** 面板事件装配（boot 调用一次） */
export function wireBacklinks(): void {
  const overlay = document.getElementById('backlinks-overlay')
  if (!overlay) return

  document.getElementById('backlinks-list')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.backlinks-hit')
    if (!(item instanceof HTMLElement)) return
    const hit = flatHits[Number(item.dataset.index)]
    if (hit) void openHit(hit)
  })
  document.getElementById('backlinks-refresh-btn')?.addEventListener('click', () => {
    void refreshBacklinks()
  })
  // 面板头部 ✕ 为显式出口
  document.getElementById('backlinks-close-btn')?.addEventListener('click', () => closeBacklinks())
  // 点击遮罩空白处关闭（与搜索/历史面板同一交互）
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeBacklinks()
  })
  // Esc 关闭（面板未打开时不做任何事）；全局收口在 main.ts 另有 closeBacklinks
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || overlay.hidden) return
    e.preventDefault()
    closeBacklinks()
  })
  // 索引刷新（保存/改名/新建触发）时若面板开着则自动重渲染
  onWikiIndexRefreshed(() => {
    void refreshBacklinks()
  })
}
