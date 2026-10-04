/**
 * 命令面板：模糊搜索并执行命令（文件 / 导出 / 格式化 / 视图 / 外观）。
 *
 * - 命令源由 main.ts 装配时经 registerCommands 注册——命令与菜单动作共用
 *   同一批处理函数（命令即菜单，不另建第二套语义），每次打开面板时重新
 *   取值，标题随界面语言、可编辑状态实时反映
 * - 评分复用 quick-switch 的 fuzzyScore 纯函数：标题命中优先，关键词命中
 *   打九折（英文关键字辅助检索中文命令，如 "source" → 源码模式）
 * - 键盘与快速切换同款：↑↓ 选择、回车执行、Esc 关闭；样式整体复用 qs-*
 *
 * @author chiangyang
 */
import { t } from './i18n'
import { fuzzyScore } from './quick-switch'

/** 面板里的单条命令 */
export interface CommandItem {
  /** 稳定标识（菜单 action 名），用于测试与去重 */
  id: string
  /** 展示标题（i18n 后的文案） */
  title: string
  /** 辅助检索关键词（通常为英文，不展示） */
  keywords?: string
  /** 执行动作 */
  run: () => void
}

/** 命令源（main.ts 装配时注册；每次打开面板时调用取最新命令列表） */
let getCommands: (() => CommandItem[]) | null = null

/** 注册命令源（幂等覆盖；传 null 注销） */
export function registerCommands(source: (() => CommandItem[]) | null): void {
  getCommands = source
}

/** 关键词命中权重：辅助检索不应压过标题命中 */
const KEYWORD_WEIGHT = 0.9

/** 命令排序纯函数：标题命中 > 关键词命中；同分标题短者在前；空查询保持原序 */
export function rankCommands(query: string, items: CommandItem[]): CommandItem[] {
  if (!query) return items
  const scored: { item: CommandItem; score: number }[] = []
  for (const item of items) {
    const byTitle = fuzzyScore(query, item.title) ?? -1
    const byKeywords = item.keywords ? (fuzzyScore(query, item.keywords) ?? -1) : -1
    const score = Math.max(byTitle, byKeywords * KEYWORD_WEIGHT)
    if (score < 0) continue
    scored.push({ item, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length)
    .map((s) => s.item)
}

/** 当前候选与选中下标（openCommandPalette 时重置） */
let ranked: CommandItem[] = []
let selected = 0

/** 打开面板并聚焦输入框 */
export function openCommandPalette(): void {
  const overlay = document.getElementById('cmdk-overlay')
  const input = document.getElementById('cmdk-input') as HTMLInputElement | null
  if (!overlay || !input || !getCommands) return
  input.value = ''
  selected = 0
  refreshList('')
  overlay.hidden = false
  input.focus()
}

/** 关闭面板 */
export function closeCommandPalette(): void {
  const overlay = document.getElementById('cmdk-overlay')
  if (overlay) overlay.hidden = true
}

/** 按当前输入重排候选并渲染列表（最多 20 条） */
function refreshList(query: string): void {
  const list = document.getElementById('cmdk-list')
  if (!list || !getCommands) return
  ranked = rankCommands(query, getCommands()).slice(0, 20)
  if (selected >= ranked.length) selected = 0
  list.textContent = ''
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i]
    const el = document.createElement('div')
    el.className = 'qs-item' + (i === selected ? ' active' : '')
    const name = document.createElement('span')
    name.className = 'qs-name'
    name.textContent = item.title
    el.appendChild(name)
    el.addEventListener('click', () => {
      closeCommandPalette()
      item.run()
    })
    list.appendChild(el)
  }
  if (!ranked.length) {
    const empty = document.createElement('div')
    empty.className = 'qs-empty'
    empty.textContent = t('cmdk.empty')
    list.appendChild(empty)
  }
}

/** 移动选中项并重绘高亮（循环） */
function moveSelection(delta: number): void {
  if (!ranked.length) return
  selected = (selected + delta + ranked.length) % ranked.length
  const list = document.getElementById('cmdk-list')
  list
    ?.querySelectorAll('.qs-item')
    .forEach((el, i) => el.classList.toggle('active', i === selected))
  list?.querySelector('.qs-item.active')?.scrollIntoView({ block: 'nearest' })
}

/** 面板事件装配（boot 调用一次） */
export function wireCommandPalette(): void {
  const overlay = document.getElementById('cmdk-overlay')
  const input = document.getElementById('cmdk-input') as HTMLInputElement | null

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
        closeCommandPalette()
        hit.run()
      }
    } else if (e.key === 'Escape') {
      closeCommandPalette()
    }
  })

  // 点击遮罩空白处关闭（与快速切换同一交互）
  overlay?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCommandPalette()
  })
}
