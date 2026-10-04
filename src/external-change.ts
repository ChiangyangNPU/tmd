/**
 * 外部修改检测与重载（桌面端；浏览器环境无 native 自然不装配）
 *
 * 主进程对「已打开的文件」做内容指纹监视（filewatcher.cjs，自身写入已被
 * 过滤），变化经 tmd:file-changed 推送到这里，按标签状态分流：
 * - 干净标签：静默重载磁盘内容（磁盘与内存一致时什么都不做，不弹提示）
 * - 脏标签：绝不自动覆盖未保存内容——顶部弹提示条，用户在「重新加载
 *   （放弃本地未保存改动）」与「保留我的版本」之间显式二选一；保留后
 *   监视继续，磁盘再有变化会再次提示
 * - 文件被移除：toast 告知，编辑器内容保留（再次保存即重建文件）
 * 提示条单实例：重复事件覆盖显示，不堆叠。
 *
 * @author chiangyang
 */
import { native } from './native'
import { activeTab, findByPath, isTabOpen, syncDirtyWith, renderTabs, type DocTab } from './tabs'
import { replaceEditor, currentMarkdown } from './editor-core'
import { normalizeEmptyTableCells } from './table-markdown'
import { showToast, syncFileWatchers } from './files'
import { t } from './i18n'

/** 订阅主进程外部修改事件（boot 时调用一次） */
export function wireFileChanged() {
  native?.onFileChanged((info) => {
    void handleFileChanged(info)
  })
}

async function handleFileChanged(info: import('./native').FileChangeInfo) {
  const tab = findByPath(info.path)
  if (!tab) {
    // 收到已不存在的路径：集合漂移（如断言外的关闭路径），按当前集合重同步
    syncFileWatchers()
    return
  }
  if (info.kind === 'unlink') {
    dismissBar()
    showToast(t('extchange.deleted', { name: tab.name }))
    return
  }
  if (!native) return
  /** @type {string} */
  let content: string
  try {
    content = (await native.readFile(info.path)).content
  } catch {
    return // 读盘间隙文件又被删除：等 unlink 事件处理
  }
  // 等待读取期间标签可能被关闭 / 另存为换了关联路径
  if (!isTabOpen(tab) || tab.path !== info.path) return
  if (tab.dirty) {
    showReloadBar(tab)
    return
  }
  // 干净标签：磁盘内容与内存一致（自身写入回声、元数据噪声）→ 静默跳过
  if (normalizeEmptyTableCells(content) === normalizeEmptyTableCells(tab.markdown)) return
  await applyExternalContent(tab, content)
  showToast(t('extchange.reloaded', { name: tab.name }))
}

/**
 * 把磁盘内容应用到标签：激活中的标签重建编辑器（脏标记随内容比对清除），
 * 后台标签只更新内容暂存。仅用于"用户已同意采用磁盘内容"的路径。
 */
async function applyExternalContent(tab: DocTab, content: string) {
  tab.markdown = content
  if (activeTab() === tab) {
    await replaceEditor(content)
    // 重建后 currentMarkdown() 即磁盘内容，与基准一致 → 清脏（内部带重绘）
    syncDirtyWith(currentMarkdown())
  } else {
    tab.dirty = false
    renderTabs()
  }
}

// ---- 提示条（单实例） ----

let bar: HTMLDivElement | null = null

function dismissBar() {
  bar?.remove()
  bar = null
}

function showReloadBar(tab: DocTab) {
  dismissBar()
  const el = document.createElement('div')
  el.className = 'extchange-bar'
  const msg = document.createElement('span')
  msg.className = 'extchange-msg'
  msg.textContent = t('extchange.changed', { name: tab.name })
  // 文案不经过 HTML 解析（textContent 赋值，文件名不可信）
  const reload = document.createElement('button')
  reload.className = 'extchange-btn extchange-reload'
  reload.textContent = t('extchange.reload')
  const keep = document.createElement('button')
  keep.className = 'extchange-btn extchange-keep'
  keep.textContent = t('extchange.keepMine')
  const close = document.createElement('button')
  close.className = 'extchange-close'
  close.textContent = '×'
  close.setAttribute('aria-label', t('extchange.keepMine'))
  reload.addEventListener('click', () => void reloadExternal(tab))
  keep.addEventListener('click', dismissBar)
  close.addEventListener('click', dismissBar)
  el.append(msg, reload, keep, close)
  document.body.appendChild(el)
  bar = el
}

/** 提示条「重新加载」：放弃本地未保存改动，采用当前磁盘内容 */
async function reloadExternal(tab: DocTab) {
  dismissBar()
  if (!native || !isTabOpen(tab) || !tab.path) return
  /** @type {string} */
  let content: string
  try {
    content = (await native.readFile(tab.path)).content
  } catch {
    showToast(t('files.openFailed'))
    return
  }
  if (!isTabOpen(tab)) return
  await applyExternalContent(tab, content)
  showToast(t('extchange.reloaded', { name: tab.name }))
}
