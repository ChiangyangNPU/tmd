/**
 * 快速切换面板：Ctrl/Cmd+P 唤起，按文件名子序列模糊搜索，回车打开。
 *
 * - 数据源三路合并去重（按路径）：已打开标签 → 文件夹树 → 最近列表，
 *   全部来自渲染层既有数据，无需主进程改动
 * - 模糊匹配：fzf 式子序列评分（fuzzyScore 纯函数）——命中词首加分、
 *   连续命中加分，得分相同偏向更短文件名
 * - 打开分发：已打开 → 跳转既有标签；未打开 → openPath 读盘新开
 * - 键盘：↑↓ 选择、回车打开、Esc 关闭（Esc 与点击遮罩关闭在 main.ts /
 *   wireQuickSwitch 各自处理）；Electron 下 Ctrl+P 菜单 accelerator 已让位
 *
 * @author chiangyang
 */
import { t } from './i18n'
import { native } from './native'
import { findByPath, activateTab, listTabs } from './tabs'
import { recentList } from './store'
import { getFolderTrees } from './files'
import { openPath } from './files'

/** 候选条目：路径唯一标识，展示名 + 所在目录 */
export interface QuickEntry {
  path: string
  name: string
  /** 所在目录（展示用；标签页无路径时不入候选） */
  dir: string
  /** 来源：已打开标签优先展示标记 */
  open?: boolean
}

// ---------------------------------------------------------------------------
// 模糊评分（纯函数）
// ---------------------------------------------------------------------------

/** 词首字符：行首 / 分隔符（/ - _ . 空格）后第一个字符 */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  return prev === '/' || prev === '-' || prev === '_' || prev === '.' || prev === ' '
}

/**
 * 子序列模糊评分：query 的每个字符按顺序出现在 text 中才算命中。
 * 评分：词首命中 +16、与上一命中连续（streak）+10、其余命中 +1；
 * 同分时调用方可用文件名长度决胜。未完全命中返回 null。
 * 大小写不敏感；query 为空返回 0（展示全部候选）。
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const s = text.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let streak = false
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) {
      streak = false
      continue
    }
    if (isWordStart(s, i)) score += 16
    else if (streak) score += 10
    else score += 1
    streak = true
    qi++
  }
  return qi === q.length ? score : null
}

/** 候选排序：得分降序，同分按文件名短者、路径字典序 */
export function rankEntries(
  query: string,
  entries: QuickEntry[],
): { entry: QuickEntry; score: number }[] {
  const scored: { entry: QuickEntry; score: number }[] = []
  for (const entry of entries) {
    const byName = fuzzyScore(query, entry.name) ?? -1
    const byPath = fuzzyScore(query, `${entry.dir}/${entry.name}`) ?? -1
    const score = Math.max(byName, byPath * 0.9) // 命中文件名优先于仅命中目录
    if (score < 0) continue
    scored.push({ entry, score })
  }
  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.name.length - b.entry.name.length ||
      a.entry.path.localeCompare(b.entry.path),
  )
}

// ---------------------------------------------------------------------------
// 数据收集与打开分发
// ---------------------------------------------------------------------------

/** 递归展平文件夹树为候选条目（仅文件，跳过目录节点） */
function flattenTree(entries: import('./filetree').FileEntry[], out: QuickEntry[]): void {
  for (const entry of entries) {
    if (entry.children) {
      flattenTree(entry.children, out)
      continue
    }
    out.push({ path: entry.path, name: entry.name, dir: parentDir(entry.path) })
  }
}

/** 取路径的目录部分（无分隔符返回空串） */
function parentDir(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : ''
}

/** 三路数据源合并去重：已打开标签 → 文件夹树 → 最近列表 */
export function collectEntries(): QuickEntry[] {
  const byPath = new Map<string, QuickEntry>()
  for (const tab of listTabs()) {
    if (!tab.path) continue
    byPath.set(tab.path, {
      path: tab.path,
      name: tab.name,
      dir: parentDir(tab.path),
      open: true,
    })
  }
  for (const tree of getFolderTrees()) {
    const flattened: QuickEntry[] = []
    flattenTree(tree.children, flattened)
    for (const entry of flattened) if (!byPath.has(entry.path)) byPath.set(entry.path, entry)
  }
  for (const recent of recentList()) {
    if (!byPath.has(recent.path)) {
      byPath.set(recent.path, {
        path: recent.path,
        name: recent.name,
        dir: parentDir(recent.path),
      })
    }
  }
  return [...byPath.values()]
}

/** 打开候选：已打开跳转既有标签，否则读盘新开（浏览器模式无壳层不响应） */
async function openEntry(entry: QuickEntry): Promise<void> {
  const existing = findByPath(entry.path)
  if (existing) {
    await activateTab(existing.id)
    return
  }
  if (!native) return
  await openPath(entry.path)
}

// ---------------------------------------------------------------------------
// 面板 DOM 装配
// ---------------------------------------------------------------------------

/** 当前候选与选中下标（openQuickSwitch 时刷新） */
let ranked: { entry: QuickEntry; score: number }[] = []
let selected = 0

/** 打开面板并聚焦输入框 */
export function openQuickSwitch(): void {
  const overlay = document.getElementById('qs-overlay')
  const input = document.getElementById('qs-input') as HTMLInputElement | null
  if (!overlay || !input) return
  input.value = ''
  selected = 0
  refreshList('')
  overlay.hidden = false
  input.focus()
}

/** 关闭面板 */
export function closeQuickSwitch(): void {
  const overlay = document.getElementById('qs-overlay')
  if (overlay) overlay.hidden = true
}

/** 按当前输入重排候选并渲染列表（最多 20 条） */
function refreshList(query: string): void {
  const list = document.getElementById('qs-list')
  if (!list) return
  ranked = rankEntries(query, collectEntries()).slice(0, 20)
  if (selected >= ranked.length) selected = 0
  list.textContent = ''
  for (let i = 0; i < ranked.length; i++) {
    const { entry } = ranked[i]
    const item = document.createElement('div')
    item.className = 'qs-item' + (i === selected ? ' active' : '')
    const name = document.createElement('span')
    name.className = 'qs-name'
    name.textContent = entry.name + (entry.open ? ' •' : '')
    const dir = document.createElement('span')
    dir.className = 'qs-dir'
    dir.textContent = entry.dir
    item.append(name, dir)
    item.addEventListener('click', () => {
      closeQuickSwitch()
      void openEntry(entry)
    })
    list.appendChild(item)
  }
  if (!ranked.length) {
    const empty = document.createElement('div')
    empty.className = 'qs-empty'
    empty.textContent = t('qs.empty')
    list.appendChild(empty)
  }
}

/** 移动选中项并重绘高亮（循环） */
function moveSelection(delta: number): void {
  if (!ranked.length) return
  selected = (selected + delta + ranked.length) % ranked.length
  const list = document.getElementById('qs-list')
  list
    ?.querySelectorAll('.qs-item')
    .forEach((el, i) => el.classList.toggle('active', i === selected))
  list?.querySelector('.qs-item.active')?.scrollIntoView({ block: 'nearest' })
}

/** 面板事件装配（boot 调用一次） */
export function wireQuickSwitch(): void {
  const overlay = document.getElementById('qs-overlay')
  const input = document.getElementById('qs-input') as HTMLInputElement | null

  input?.addEventListener('input', () => refreshList(input.value))
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = ranked[selected]
      if (hit) {
        closeQuickSwitch()
        void openEntry(hit.entry)
      }
    } else if (e.key === 'Escape') {
      closeQuickSwitch()
    }
  })

  // 点击遮罩空白处关闭（与设置面板同一交互）
  overlay?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeQuickSwitch()
  })
}
