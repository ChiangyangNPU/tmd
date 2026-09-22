/**
 * 标签页状态机：文档标签的创建/激活/关闭、标签栏渲染、标题与脏状态同步、
 * 每标签滚动位置暂存/恢复。
 *
 * 依赖 editor-core（replaceEditor/currentMarkdown/destroyEditor）与
 * image-resolver（图片目录随激活标签切换）；不反向被 editor-core 依赖。
 */
import { replaceEditor, currentMarkdown, destroyEditor } from './editor-core'
import { setImageBaseDir } from './image-resolver'
import { native } from './native'
import { t } from './i18n'
import { dirOf } from './fs-path'
import { normalizeEmptyTableCells } from './table-markdown'

/** 打开的文档标签页：一个标签对应一份在编辑的文档 */
export interface DocTab {
  id: string
  /** 关联的磁盘文件绝对路径；未保存过的新文档为 undefined */
  path?: string
  /** 标签页展示名（文件名） */
  name: string
  /** 打开/保存时的基准内容，用于判断是否有未保存修改 */
  markdown: string
  dirty: boolean
  /** 标记该标签是启动时从 localStorage 恢复的上次未保存内容（不可被"打开文件"原地替换） */
  recovered?: boolean
  /** 切走时的滚动位置（切换回来时恢复） */
  scrollTop?: number
}

/** 全部打开的标签页（有序） */
const tabs: DocTab[] = []
/** 当前激活标签页 id */
let activeTabId: string | null = null
/** 标签页自增 id 计数 */
let tabSeq = 0

/** 页面滚动容器（记录/恢复滚动位置用） */
function scrollEl(): HTMLElement | null {
  return document.querySelector('.page-scroll')
}

/** 获取当前激活的标签页数据 */
export function activeTab(): DocTab | undefined {
  return tabs.find((t) => t.id === activeTabId)
}

/** 全部标签页（只读副本，快速切换面板枚举用） */
export function listTabs(): DocTab[] {
  return [...tabs]
}

/** 获取当前激活标签页 id */
export function getActiveTabId(): string | null {
  return activeTabId
}

/** 设置当前激活标签页 id（不重绘 UI，调用方负责） */
export function setActiveTabId(id: string | null) {
  activeTabId = id
}

/** 是否存在任一未保存标签（关闭确认/恢复副本清理用） */
export function hasDirty(): boolean {
  return tabs.some((t) => t.dirty)
}

/** 同路径已打开的标签（打开文件去重用） */
export function findByPath(path: string): DocTab | undefined {
  return tabs.find((t) => t.path === path)
}

/** 可被"打开文件"原地替换的空白标签索引（无路径、无修改、空内容、非恢复），无则 -1 */
export function blankIndex(): number {
  return tabs.findIndex((t) => !t.path && !t.recovered && !t.dirty && t.markdown === '')
}

/** 取空白标签对象（原地替换用） */
export function blankTab(): DocTab | undefined {
  const idx = blankIndex()
  return idx !== -1 ? tabs[idx] : undefined
}

/** 当前激活标签的文件目录（图片相对路径解析用） */
export function getActiveBaseDir(): string | null {
  const tab = activeTab()
  return tab?.path ? dirName(tab.path) : null
}

/** 取路径的目录部分（兼容 / 与 \ 分隔符；无分隔符时原样返回） */
function dirName(p: string): string {
  return dirOf(p) || p
}

/** 同步窗口标题（工具栏居中文件名 + 未保存圆点标记）并更新图片显示目录 */
export function updateTitle() {
  const tab = activeTab()
  const text = `${tab?.dirty ? '• ' : ''}${tab?.name ?? t('tab.untitled')}`
  document.title = text
  // 两平台共用：工具栏居中文件名（Mac 红绿灯浮左侧，Win 窗口按钮在右缘）
  const el = document.getElementById('win-title')
  if (el) el.textContent = text
  // 相对路径图片的显示解析目录跟随当前文档位置
  setImageBaseDir(getActiveBaseDir())
}

/** 把任一标签页的未保存状态同步给 Electron 主进程（关闭确认用） */
function notifyDirty() {
  native?.setDirty(hasDirty())
}

/** 当前标签置脏并刷新标签栏与标题（文档变更钩子调用） */
export function markDirty() {
  const tab = activeTab()
  if (tab && !tab.dirty) {
    tab.dirty = true
    renderTabs()
    updateTitle()
  }
}

/**
 * 按当前 markdown 与基准内容比对，同步脏状态（撤销 / 回退到原状时清脏）。
 *
 * 与 markDirty 的区别：markDirty 是单向置脏（强制，用于历史版本恢复等
 * 显式动作）；本函数按内容比对，相等清、不等置。基准为 tab.markdown
 * （打开 / 保存时更新）。两侧都过 normalizeEmptyTableCells 规范化，
 * 避免空表格单元格 <br /> 占位的往返差异造成伪脏。
 *
 * 由 main.ts 的 onMarkdownChange 防抖回调（800ms 节拍）调用，零额外
 * 序列化成本——复用该回调已算好的 markdown 串。因此清脏有约 800ms
 * 延迟（与 Typora 同样异步，可接受）。
 */
export function syncDirtyWith(md: string) {
  const tab = activeTab()
  if (!tab) return
  const dirty = normalizeEmptyTableCells(md) !== normalizeEmptyTableCells(tab.markdown)
  if (tab.dirty === dirty) return
  tab.dirty = dirty
  renderTabs()
  updateTitle()
}

/** 创建一个标签页数据（不激活） */
export function newTab(name: string, markdown: string, path?: string): DocTab {
  const tab: DocTab = { id: `tab-${++tabSeq}`, name, markdown, dirty: false, path }
  tabs.push(tab)
  return tab
}

/** 重绘标签栏（含未保存圆点、激活高亮、关闭按钮）并同步脏状态到主进程 */
export function renderTabs() {
  notifyDirty()
  const bar = document.getElementById('tab-bar')
  if (!bar) return
  bar.textContent = ''
  for (const tab of tabs) {
    const el = document.createElement('div')
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}`
    // 右键菜单按 id 定位标签（DOM 每次重绘重建，不能靠元素引用）
    el.dataset.tabId = tab.id
    const label = document.createElement('span')
    label.textContent = `${tab.dirty ? '• ' : ''}${tab.name}`
    const close = document.createElement('button')
    close.className = 'tab-close'
    close.textContent = '✕'
    close.title = t('menu.closeTab')
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void closeTab(tab.id)
    })
    el.append(label, close)
    el.addEventListener('click', () => void activateTab(tab.id))
    bar.appendChild(el)
  }
  // 标签后的「+」新建入口（点击标签栏空白区同样有效）
  const plus = document.createElement('button')
  plus.className = 'tab-new'
  plus.textContent = '+'
  plus.title = t('menu.newTab')
  plus.addEventListener('click', () => createNewTab())
  bar.appendChild(plus)
}

/** 激活指定标签页：暂存当前标签内容与滚动位置 → 重建编辑器载入目标内容 */
export async function activateTab(id: string) {
  if (id === activeTabId) return
  const current = activeTab()
  if (current) {
    current.markdown = currentMarkdown()
    current.scrollTop = scrollEl()?.scrollTop ?? 0
  }

  const target = tabs.find((t) => t.id === id)
  if (!target) return
  activeTabId = id
  renderTabs()
  updateTitle()
  await replaceEditor(target.markdown, { scrollTop: target.scrollTop })
}

/**
 * 生成下一个可用的未命名标签名：未命名.md → 未命名-1.md → 未命名-2.md。
 * 在已打开标签中查重；词干取自当前语言包（中文"未命名"/英文"Untitled"）。
 */
export function nextUntitledName(): string {
  const base = t('tab.untitled')
  const stem = base.replace(/\.(md|markdown)$/i, '')
  const ext = base.slice(stem.length)
  const taken = new Set(tabs.map((tb) => tb.name))
  if (!taken.has(base)) return base
  let n = 1
  while (taken.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}

/** 新建一个空白标签页并激活（工具栏「+」/ 空白区双击 / 快捷键 / 菜单共用） */
export function createNewTab() {
  const created = newTab(nextUntitledName(), '')
  void activateTab(created.id)
}

/**
 * 关闭标签页。有未保存修改时弹确认；
 * 关闭最后一个标签时直接关闭窗口（Mac 惯例，应用留在后台）。
 */
export async function closeTab(id: string) {
  const tab = tabs.find((t) => t.id === id)
  if (!tab) return
  // 脏标记由编辑事件维护（仅真实编辑会置位），不要用序列化内容反比——
  // markdown 序列化会规范化文本（尾随空格、列表标记等），未修改的文档也会被判为已修改
  if (tab.dirty && !window.confirm(t('dialog.closeConfirm', { name: tab.name }))) return

  const index = tabs.indexOf(tab)
  tabs.splice(index, 1)
  if (activeTabId === id) {
    activeTabId = null
    const next = tabs[Math.min(index, tabs.length - 1)]
    if (next) {
      await activateTab(next.id)
    } else if (native) {
      // 最后一个标签页已关闭：直接关窗口（Mac 惯例，应用留在后台）
      await destroyEditor()
      window.close()
      return
    } else {
      // 浏览器模式：window.close 无效，退回新建空白页
      await destroyEditor()
      newTab(nextUntitledName(), '')
      await activateTab(tabs[0].id)
    }
  }
  renderTabs()
  updateTitle()
}

/**
 * 批量关闭标签页（标签右键菜单的关闭其他/左侧/右侧/已保存/全部共用）。
 *
 * - 确认：整批只弹一次——待关闭标签中有脏页时按数量确认，用户同意后全部
 *   直接丢弃，不再逐个弹窗；单标签的确认文案见 closeTab（带文件名，用于"关闭"项）
 * - 激活链路：当前激活标签被关闭时优先激活幸存的锚点标签（右键对象，如
 *   "关闭其他"语义上应留在原地），否则激活紧邻被关区域的标签；全部关完时
 *   走 closeTab 同款的"关最后一个标签"链路（桌面关窗口 / 浏览器回空白页）
 * @param ids 待关闭的标签 id 列表
 * @param anchorId 右键锚点标签 id（幸存时优先激活；可省略）
 */
export async function closeTabsBulk(ids: string[], anchorId?: string) {
  const targets = ids
    .map((id) => tabs.find((tb) => tb.id === id))
    .filter((tb): tb is DocTab => !!tb)
  if (!targets.length) return
  const dirtyCount = targets.filter((tb) => tb.dirty).length
  if (dirtyCount > 0 && !window.confirm(t('dialog.closeBulkConfirm', { count: dirtyCount }))) return

  const firstIndex = Math.min(...targets.map((tb) => tabs.indexOf(tb)))
  const anchor = anchorId ? tabs.find((tb) => tb.id === anchorId) : undefined
  const activeClosed = targets.some((tb) => tb.id === activeTabId)

  for (const tb of targets) tabs.splice(tabs.indexOf(tb), 1)

  if (activeClosed) {
    activeTabId = null
    if (anchor && !targets.includes(anchor)) {
      await activateTab(anchor.id)
    } else {
      const next = tabs[Math.min(firstIndex, tabs.length - 1)]
      if (next) {
        await activateTab(next.id)
      } else if (native) {
        // 全部关闭：与 closeTab 的最后一个标签同款（Mac 惯例，应用留在后台）
        await destroyEditor()
        window.close()
        return
      } else {
        await destroyEditor()
        newTab(nextUntitledName(), '')
        await activateTab(tabs[0].id)
        return
      }
    }
  }
  renderTabs()
  updateTitle()
}
