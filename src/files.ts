/**
 * 文件操作：打开 / 保存 / 文件夹树 / 最近列表（Electron 原生对话框 + 浏览器降级）。
 *
 * 依赖 tabs（访问器与激活/新建）、editor-core（重建编辑器）、store（最近列表
 * 与恢复副本）、filetree（纯渲染）。
 */
import { native } from './native'
import { replaceEditor, currentMarkdown, flushMarkdownSync } from './editor-core'
import {
  activeTab,
  activateTab,
  newTab,
  renderTabs,
  updateTitle,
  findByPath,
  blankTab,
  hasDirty,
  isTabOpen,
  syncDirtyWith,
  listTabs,
  setOnTabsSetChanged,
  type DocTab,
} from './tabs'
import {
  pushRecent,
  recentList,
  clearRecent,
  removeRecent,
  clearDoc,
  folderList,
  pushFolder,
  removeFolder,
  clearFolders,
} from './store'
import {
  renderRecent,
  renderFolders,
  beginInlineCreate,
  beginRename,
  type FolderMenuTarget,
} from './filetree'
import { normalizeEmptyTableCells } from './table-markdown'
import { invalidateWikiIndex, wikiIndexOnSave, getWikiLinks } from './wikilink-index'
import { rewriteLinksForRename } from './link-rewrite'
import { t } from './i18n'

/** 已打开文件夹的目录树缓存（绝对路径 → 子节点）；重启后首次展开时懒加载 */
const folderChildrenCache = new Map<string, import('./filetree').FileEntry[]>()

/** 当前展开的文件夹路径集合（仅内存态，重启后全部折叠） */
const expandedFolders = new Set<string>()

/** 当前已打开且目录树已加载的文件夹（快速切换面板枚举用；未展开加载的不含） */
export function getFolderTrees(): {
  path: string
  name: string
  children: import('./filetree').FileEntry[]
}[] {
  return folderList().flatMap((f) => {
    const children = folderChildrenCache.get(f.path)
    return children ? [{ path: f.path, name: f.name, children }] : []
  })
}

/** 轻量浮层提示（复用 .toast 样式，3 秒后自动消失） */
export function showToast(message: string) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

/** 记录一条最近打开文件并刷新侧边栏，同时注册到系统最近文档与主进程菜单 */
function pushRecentWithRender(path: string, name: string) {
  pushRecent(path, name)
  native?.recentAdd({ path, name })
  renderFilesSidebar()
}

/**
 * 全量同步「已打开文件」集合给主进程的外部修改监视器（差量增删 watcher）。
 * 在开关标签 / 打开 / 另存为后调用；浏览器环境无 native 自然跳过。
 */
export function syncFileWatchers() {
  const paths = [...new Set(listTabs().flatMap((tb) => (tb.path ? [tb.path] : [])))]
  native?.watchFiles(paths)
}

/**
 * 装配外部修改监视（boot 时调用一次）：
 * 注册标签集合变化钩子（关闭标签后收缩监视集合）并做首次同步。
 * 变化事件的订阅在 external-change.ts（wireFileChanged），此处不碰 UI。
 */
export function initFileWatcherBridge() {
  setOnTabsSetChanged(() => syncFileWatchers())
  syncFileWatchers()
}

/**
 * 打开文档：
 * - Electron：原生文件选择对话框（自动去重已打开的同路径文件）
 * - 浏览器：降级为 <input type="file">
 */
export async function openDocument() {
  if (native) {
    try {
      const result = await native.openFile()
      if (result) await openFromData(result)
    } catch (err) {
      // 读取失败（权限 / 文件已删除）：提示而不是抛未捕获异常
      console.error('[tmd] 打开文件失败', err)
      showToast(t('files.openFailed'))
    }
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.markdown,text/markdown'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    file.text().then((content) => openFromData({ name: file.name, content }))
  }
  input.click()
}

/**
 * 用读取到的文件数据打开文档：
 * 同路径已打开 → 跳转既有标签；唯一的空白"未命名"标签 → 原地替换；否则新建标签。
 */
export async function openFromData(data: { path?: string; name: string; content: string }) {
  // 已打开同一文件 → 跳到那个标签页（集合未变，无需重新同步监视）
  if (data.path) {
    const existing = findByPath(data.path)
    if (existing) {
      await activateTab(existing.id)
      return
    }
    pushRecentWithRender(data.path, data.name)
  }
  // 唯一的"未命名"空白标签页 → 原地替换，避免启动时残留空标签
  // 替换对象：任意"空白新建标签"（无路径、无修改、内容为空、非恢复内容）；
  // 恢复出来的未保存内容带 recovered 标记，不会被打开的文件覆盖
  const only = blankTab()
  if (only) {
    only.path = data.path
    only.name = data.name
    only.markdown = data.content
    await replaceEditor(data.content)
    renderTabs()
    updateTitle()
    syncFileWatchers()
    return
  }
  const tab = newTab(data.name, data.content, data.path)
  await activateTab(tab.id)
  syncFileWatchers()
}

/**
 * 保存操作串行化：手动保存（Cmd+S）与定时自动保存可能在同一时刻触发，
 * 并发写同一文件时两次 writeFile 的完成顺序不可控——后发起的先落盘时，
 * 磁盘反而退回旧内容，而内存与 tab.markdown 都是新内容、脏标记又被清掉，
 * 用户完全无从察觉。入队串行执行，保证后一次写入的一定是更新的内容。
 */
let saveQueue: Promise<void> = Promise.resolve()

/**
 * 保存当前标签页：
 * - 已关联磁盘文件 → 直接写回；未关联 → 弹"另存为"
 * - 浏览器降级为下载 .md 文件
 *
 * 目标标签与内容在调用时刻捕获（"保存我按下的那一刻"），写盘动作入队串行执行；
 * 基准（tab.markdown）只在写盘成功后推进——若在捕获时就推进，写盘失败 / 另存
 * 取消后基准已前移，用户撤销回原内容会被 syncDirtyWith 清脏（磁盘还是旧内容），
 * 关闭确认与自动保存随之失效。写盘失败保留脏标记并提示，绝不静默当作成功。
 */
export function saveDocument(saveAs = false): Promise<void> {
  const tab = activeTab()
  if (!tab) return Promise.resolve()
  // 先冲刷挂起中的低优序列化：其回调会把恢复副本写回，若排在写盘成功
  // clearDoc 之后执行，已保存的文档会以「恢复副本」复活（下次启动多出
  // 一个与磁盘相同的 recovered 标签）。冲刷后捕获的内容即最新，写盘成功
  // 清副本时不再有悬挂回调
  flushMarkdownSync()
  const markdown = currentMarkdown()
  saveQueue = saveQueue
    .then(() => doSaveDocument(tab, markdown, saveAs))
    .catch((err) => {
      console.error('[tmd] 保存流程异常', err)
      showToast(t('files.saveFailed'))
    })
  return saveQueue
}

/** 实际写盘（由 saveDocument 串行调用）：成功后推进基准并按需清脏，失败保留脏标记 */
async function doSaveDocument(tab: DocTab, markdown: string, saveAs: boolean) {
  // 捕获到执行之间标签可能已被用户"放弃修改"关闭：明确放弃的内容不得再写盘
  if (!isTabOpen(tab)) return
  if (native) {
    try {
      if (tab.path && !saveAs) {
        await native.saveFile(tab.path, markdown)
      } else {
        const result = await native.saveFileAs(markdown)
        if (!result) return
        tab.path = result.path
        tab.name = result.name
        pushRecentWithRender(result.path, result.name)
      }
    } catch (err) {
      // 磁盘满 / 权限拒绝 / 路径失效：保留脏标记（关闭时仍会确认），并明确告知用户
      console.error('[tmd] 保存失败', err)
      showToast(t('files.saveFailed'))
      return
    }
    // 另存为会改变标签关联路径：按新集合重同步外部修改监视
    syncFileWatchers()
    // 写盘可能增删 wikilink：内容含 [[ 时调度防抖重扫（无双链文档零开销）
    wikiIndexOnSave(markdown)
  } else {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = tab.name
    a.click()
    URL.revokeObjectURL(url)
  }
  // 落盘期间内容可能又变了（捕获后继续输入），须与磁盘内容比对后才清脏——
  // 一致才清，不一致保持置脏（等待下一次自动保存 / 手动保存）
  if (activeTab() === tab) {
    tab.markdown = markdown
    syncDirtyWith(currentMarkdown())
  } else {
    // 已切走的标签：tab.markdown 是切走时的内容暂存（重新激活时加载），不能覆盖；
    // 只按暂存内容与落盘内容比对重算脏标记。基准推进留给重新激活后的下一次保存
    tab.dirty = normalizeEmptyTableCells(tab.markdown) !== normalizeEmptyTableCells(markdown)
  }
  // 另存为会改标签名：脏标记未变时 syncDirtyWith 会早退，这里无条件重绘
  renderTabs()
  // 已无未保存内容时清除恢复副本，避免下次启动"复活"已保存的旧文档
  if (!hasDirty()) clearDoc()
  updateTitle()
}

/** 打开文件夹：追加到工作区列表并展开（同路径去重），目录树缓存到内存（仅 Electron） */
export async function openFolder() {
  if (!native) return
  const dir = await native.openFolder()
  if (!dir) return
  const tree = await native.readDir(dir)
  if (!tree) return
  pushFolder(tree.path, tree.name)
  folderChildrenCache.set(tree.path, tree.children)
  expandedFolders.add(tree.path)
  // 工作区根变化：双链索引按新根集合重扫
  invalidateWikiIndex(true)
  renderFilesSidebar()
}

/** 展开/收起文件夹：重启后恢复的条目首次展开时懒加载目录树，失败提示而不是抛异常 */
async function toggleFolder(path: string) {
  if (expandedFolders.has(path)) {
    expandedFolders.delete(path)
    renderFilesSidebar()
    return
  }
  if (!folderChildrenCache.has(path)) {
    if (!native) return
    try {
      const tree = await native.readDir(path)
      if (!tree) throw new Error('readDir returned null')
      folderChildrenCache.set(path, tree.children)
    } catch {
      showToast(t('files.folderOpenFailed'))
      return
    }
  }
  expandedFolders.add(path)
  renderFilesSidebar()
}

/**
 * 重载已加载的文件夹树（切换界面语言后调用）。
 *
 * 目录树由主进程按界面语言排序（中文文件名走当地排序规则），缓存里仍是旧序，
 * 需重新读盘；未加载过的条目本就在首次展开时才读取，无需处理。单个文件夹
 * 读取失败时保留旧缓存（不提示，避免切换语言时弹无关错误）。
 */
export async function reloadFolderTrees() {
  if (!native) return
  let reloaded = false
  for (const path of [...expandedFolders]) {
    if (!folderChildrenCache.has(path)) continue
    try {
      const tree = await native.readDir(path)
      if (!tree) continue
      folderChildrenCache.set(path, tree.children)
      reloaded = true
    } catch {
      /* 读盘失败：保留旧缓存，下次展开/重启再刷新 */
    }
  }
  if (reloaded) renderFilesSidebar()
}

/** 按绝对路径打开文件（文件树 / 最近列表 / 系统最近菜单点击时）；
 *  文件已被移动或删除时提示而不是抛未捕获异常（最近条目天然可能失效） */
export async function openPath(path: string) {
  if (!native) return
  try {
    const result = await native.readFile(path)
    await openFromData(result)
  } catch {
    showToast(t('files.openFailed'))
  }
}

/** 清空最近文件：本地列表 + 系统最近文档/主进程菜单 + 侧边栏刷新 */
export function clearRecentDocuments() {
  clearRecent()
  native?.recentClear()
  renderFilesSidebar()
}

/** 移除单条最近文件：本地列表 + 同步主进程菜单与系统最近文档 */
export function removeRecentDocument(path: string) {
  removeRecent(path)
  native?.recentRemove(path)
  renderFilesSidebar()
}

/** 移除单个已打开文件夹：仅从侧边栏列表移除并清缓存，不删除磁盘文件 */
export function removeFolderEntry(path: string) {
  removeFolder(path)
  invalidateWikiIndex(true)
  folderChildrenCache.delete(path)
  expandedFolders.delete(path)
  renderFilesSidebar()
}

/** 清空全部已打开文件夹：仅清空侧边栏列表与缓存，不删除磁盘文件 */
export function clearFolderEntries() {
  clearFolders()
  invalidateWikiIndex(true)
  folderChildrenCache.clear()
  expandedFolders.clear()
  renderFilesSidebar()
}

// ---------- 侧边栏文件管理（新建 / 重命名 / 在系统中显示；桌面端专属） ----------

/** 重读包含 dir 的（最近的）已挂载根目录并重渲染；都读不到时仅重渲染 */
async function refreshTreeRootContaining(dir: string) {
  if (native) {
    const root = [...folderList()]
      .sort((a, b) => b.path.length - a.path.length)
      .find((f) => dir === f.path || dir.startsWith(f.path + '/') || dir.startsWith(f.path + '\\'))
    if (root) {
      try {
        const tree = await native.readDir(root.path)
        if (tree) folderChildrenCache.set(root.path, tree.children)
      } catch {
        /* 目录读取失败：保留旧缓存 */
      }
    }
  }
  renderFilesSidebar()
}

/** 在 dir 下新建文件（自动补 .md）或文件夹：成功后刷新树，文件直接打开 */
export async function createEntryIn(dir: string, kind: 'file' | 'dir', name: string) {
  if (!native) return
  try {
    const result =
      kind === 'file' ? await native.createFile(dir, name) : await native.createDir(dir, name)
    if (kind === 'file') invalidateWikiIndex(true)
    await refreshTreeRootContaining(dir)
    if (kind === 'file') await openPath(result.path)
  } catch (err) {
    console.error('[tmd] 新建失败', err)
    showToast(t('files.createFailed'))
  }
}

/** 重命名（同目录内）：同步打开标签的关联路径与名称，避免后续写回旧路径 */
export async function renameEntry(path: string, newName: string) {
  if (!native) return
  try {
    // 改名前捕获双链索引快照：引用重写依据「改名前解析指向旧路径」的链接
    const preScan = await getWikiLinks().catch(() => null)
    const result = await native.renamePath(path, newName)
    // 路径变化使索引失效：立即重扫
    invalidateWikiIndex(true)
    const tab = findByPath(path)
    if (tab) {
      tab.path = result.path
      tab.name = result.name
      renderTabs()
      syncFileWatchers()
    }
    await refreshTreeRootContaining(result.path)
    // 自动重写全工作区引用（Obsidian 式行为）：toast 汇总更新文件数
    if (preScan) {
      const updated = await rewriteLinksForRename({
        oldPath: path,
        newPath: result.path,
        preScan,
      })
      if (updated > 0) showToast(t('wikilink.rewritten', { count: updated }))
    }
  } catch (err) {
    console.error('[tmd] 重命名失败', err)
    showToast(t('files.renameFailed'))
  }
}

/** 行右键菜单单实例（点击任意处关闭） */
let folderMenu: HTMLElement | null = null

function hideFolderMenu() {
  folderMenu?.remove()
  folderMenu = null
}

/** 关闭文件树右键菜单（Esc 统一收口等调用） */
export function closeFolderMenu(): void {
  hideFolderMenu()
}

/** 右键「关旧菜单」监听只注册一次（showFolderMenu 每次开菜单都会触发） */
let folderMenuCloserWired = false

function ensureFolderMenuCloser() {
  if (folderMenuCloserWired) return
  folderMenuCloserWired = true
  // 右键不产生 click，仅靠一次性 click 关外会残留：菜单开着时在别处右键先关掉。
  // 命中树行时行处理器会原地重开（先于本监听冒泡到 document），不当作「别处」
  document.addEventListener('contextmenu', (e) => {
    if (!folderMenu) return
    const target = e.target as HTMLElement
    if (target.closest('.file-context-menu') || target.closest('.tree-file, .tree-folder')) return
    hideFolderMenu()
  })
}

/** 文件树行右键菜单：目录行多「新建」两项（子树已展开时），全部行可重命名/显示 */
function showFolderMenu(target: FolderMenuTarget) {
  hideFolderMenu()
  ensureFolderMenuCloser()
  const isDir = target.entry.children != null
  const subVisible = !!target.subContainer && !target.subContainer.hidden
  const menu = document.createElement('div')
  menu.className = 'more-menu file-context-menu'
  const add = (label: string, fn: () => void) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'menu-item'
    item.textContent = label
    item.addEventListener('click', () => {
      hideFolderMenu()
      fn()
    })
    menu.appendChild(item)
  }
  if (isDir && subVisible) {
    const createIn = target.subContainer as HTMLElement
    add(t('files.newFile'), () => {
      beginInlineCreate(createIn, 1, (name) => void createEntryIn(target.entry.path, 'file', name))
    })
    add(t('files.newFolder'), () => {
      beginInlineCreate(createIn, 1, (name) => void createEntryIn(target.entry.path, 'dir', name))
    })
  }
  add(t('files.rename'), () => {
    const ok = beginRename(
      target.treeContainer,
      target.entry.path,
      (name) => void renameEntry(target.entry.path, name),
    )
    if (!ok) showToast(t('files.renameFailed'))
  })
  add(t('files.reveal'), () => void native?.revealInFolder(target.entry.path))
  document.body.appendChild(menu)
  // 视口钳制：先挂载量尺寸再定位，避免超出右/下边缘
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(target.x, window.innerWidth - rect.width - 8))}px`
  menu.style.top = `${Math.max(4, Math.min(target.y, window.innerHeight - rect.height - 8))}px`
  folderMenu = menu
  // 右键本身不产生 click；等当前事件循环结束再挂一次性关闭监听
  setTimeout(() => document.addEventListener('click', hideFolderMenu, { once: true }), 0)
}

/** 渲染文件树侧边栏（最近列表 + 文件夹树） */
export function renderFilesSidebar() {
  const recent = recentList()
  // 「清空」按钮仅在最近列表非空时显示
  const clearBtn = document.getElementById('clear-recent-btn')
  if (clearBtn) clearBtn.hidden = recent.length === 0
  const recentEl = document.getElementById('recent-list')
  if (recentEl)
    renderRecent(
      recentEl,
      recent,
      (p) => void openPath(p),
      (p) => removeRecentDocument(p),
    )
  const treeEl = document.getElementById('folder-tree')
  if (treeEl) {
    const folders = folderList().map((f) => ({
      ...f,
      expanded: expandedFolders.has(f.path),
      children: folderChildrenCache.get(f.path),
    }))
    // 文件夹「清空」按钮仅在列表非空时显示
    const clearFolderBtn = document.getElementById('clear-folder-btn')
    if (clearFolderBtn) clearFolderBtn.hidden = folders.length === 0
    renderFolders(
      treeEl,
      folders,
      (p) => void openPath(p),
      (p) => void toggleFolder(p),
      (p) => removeFolderEntry(p),
      native
        ? {
            onCreate: (dir, kind, name) => void createEntryIn(dir, kind, name),
            onRename: (p, name) => void renameEntry(p, name),
            onReveal: (p) => void native?.revealInFolder(p),
            onMenu: (target) => showFolderMenu(target),
          }
        : undefined,
    )
  }
}
