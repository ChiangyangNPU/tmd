/**
 * 历史版本面板：列出当前文档在本机的快照（每次保存前自动留存），
 * 支持预览与「恢复到编辑器」。
 *
 * 职责边界：本模块只管面板交互与快照读取；真正把内容写回编辑器由 main.ts
 * 注入的 onRestore 完成（那里才有恢复副本 / 字数 / 脏标记的完整处理）。
 * 恢复只改编辑器内容、不直接落盘——是否覆盖磁盘由用户后续的保存动作决定。
 */
import { native } from './native'
import type { FileHistory } from './native'
import { activeTab } from './tabs'
import { showToast } from './files'
import { getLocale, t } from './i18n'

/** 面板需要宿主提供的动作（main.ts 注入） */
export interface HistoryHooks {
  /** 把快照正文载入编辑器并置脏（不落盘） */
  onRestore(content: string): Promise<void> | void
}

let hooks: HistoryHooks | null = null
/** 当前展示的文件历史（打开面板时加载一次） */
let current: FileHistory | null = null
/** 当前选中的快照 id（未选中为 null，恢复按钮据此置灰） */
let selectedId: string | null = null
/** 预览请求序号：快速点选多条快照时，只认最后一次请求的结果 */
let previewSeq = 0

/**
 * 时间展示：跟随界面语言，强制 24 小时制（列表列宽有限，
 * 且跨语言统一形态比 AM/PM 更紧凑易扫读）。
 */
function formatTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

/** 字节数展示（快照均为文本，KB 量级足够） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function setStatus(text: string) {
  const el = document.getElementById('history-status')
  if (el) el.textContent = text
}

function setPreview(text: string) {
  const el = document.getElementById('history-preview')
  if (el) el.textContent = text
}

/** 恢复按钮仅在选中快照后可用 */
function updateRestoreButton() {
  const btn = document.getElementById('history-restore-btn')
  if (btn instanceof HTMLButtonElement) btn.disabled = !selectedId
}

/** 重绘左侧快照列表（最新在前，与主进程返回顺序一致） */
function renderList() {
  const list = document.getElementById('history-list')
  if (!list) return
  list.textContent = ''
  for (const snap of current?.snapshots ?? []) {
    const item = document.createElement('div')
    item.className = `history-item${snap.id === selectedId ? ' active' : ''}`
    item.dataset.id = snap.id
    const time = document.createElement('span')
    time.className = 'history-item-time'
    time.textContent = formatTime(snap.ts)
    const size = document.createElement('span')
    size.className = 'history-item-size'
    size.textContent = formatSize(snap.size)
    item.append(time, size)
    list.appendChild(item)
  }
  updateRestoreButton()
}

/** 选中某条快照：拉取正文填入右侧预览 */
async function selectSnapshot(id: string) {
  const tab = activeTab()
  if (!native || !tab?.path) return
  selectedId = id
  renderList()
  const seq = ++previewSeq
  const entry = await native.readHistory(tab.path, id).catch(() => null)
  // 期间用户又点了别的快照：本次结果作废，避免预览与列表高亮不一致
  if (seq !== previewSeq) return
  if (!entry) {
    setPreview('')
    showToast(t('history.loadFailed'))
    return
  }
  setPreview(entry.content)
}

/** 恢复选中的快照：交给宿主写回编辑器，成功后关闭面板 */
async function restoreSelected() {
  const tab = activeTab()
  if (!hooks || !native || !selectedId || !tab?.path) return
  const entry = await native.readHistory(tab.path, selectedId).catch(() => null)
  if (!entry) {
    showToast(t('history.loadFailed'))
    return
  }
  try {
    await hooks.onRestore(entry.content)
  } catch (err) {
    // 写回编辑器失败（如编辑器正在重建）：提示并保持面板打开，便于重试
    console.error('[tmd] 恢复历史版本失败', err)
    showToast(t('history.restoreFailed'))
    return
  }
  closeHistory()
  showToast(t('history.restored'))
}

/** 关闭历史面板并清空选中态 */
export function closeHistory() {
  document.getElementById('history-overlay')?.setAttribute('hidden', '')
  current = null
  selectedId = null
}

/**
 * 打开历史面板：加载当前标签的快照清单。
 * 未命名（未落盘）文档没有历史——快照只在写盘时产生。
 */
export async function openHistory() {
  const overlay = document.getElementById('history-overlay')
  if (!overlay || !native) return
  selectedId = null
  overlay.hidden = false

  const tab = activeTab()
  if (!tab?.path) {
    current = null
    setStatus(t('history.untitled'))
    setPreview(t('history.hint'))
    renderList()
    return
  }

  current = await native.listHistory(tab.path).catch(() => null)
  if (!current || current.snapshots.length === 0) {
    setStatus(t('history.empty'))
    setPreview(t('history.hint'))
  } else {
    setStatus(t('history.summary', { count: current.snapshots.length }))
    setPreview(t('history.previewHint'))
  }
  renderList()
}

/** 面板事件装配（boot 时调用一次） */
export function wireHistory(userHooks: HistoryHooks) {
  hooks = userHooks
  const overlay = document.getElementById('history-overlay')
  if (!overlay) return

  document.getElementById('history-list')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.history-item')
    if (!(item instanceof HTMLElement)) return
    const id = item.dataset.id
    if (id) void selectSnapshot(id)
  })
  document.getElementById('history-restore-btn')?.addEventListener('click', () => {
    void restoreSelected()
  })
  // 点击遮罩空白处关闭（与搜索面板、设置面板同一交互）
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeHistory()
  })
  // 面板内无输入框，Esc 挂在文档上；面板未打开时不做任何事
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || overlay.hidden) return
    e.preventDefault()
    closeHistory()
  })
}
