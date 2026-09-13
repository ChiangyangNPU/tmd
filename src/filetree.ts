/**
 * 文件树 / 最近文件 / 已打开文件夹 渲染（数据来自 Electron IPC）
 *
 * @author chiangyang
 */
import { t } from './i18n'

/** 文件树节点：目录含 children，文件无 */
export interface FileEntry {
  name: string
  path: string
  children?: FileEntry[]
}

/** 最近打开文件条目 */
export interface RecentEntry {
  name: string
  path: string
}

/** 递归渲染目录树：目录行点击展开/收起，文件行点击触发 onOpen 回调 */
export function renderFileTree(
  container: HTMLElement,
  entries: FileEntry[],
  onOpen: (path: string) => void,
  depth = 0,
) {
  for (const item of entries) {
    const row = document.createElement('div')
    row.className = item.children ? 'tree-folder' : 'tree-file'
    row.style.paddingLeft = `${8 + depth * 14}px`
    row.textContent = item.name
    container.appendChild(row)

    if (item.children) {
      const sub = document.createElement('div')
      sub.hidden = true
      row.addEventListener('click', () => {
        sub.hidden = !sub.hidden
      })
      container.appendChild(sub)
      renderFileTree(sub, item.children, onOpen, depth + 1)
    } else {
      row.addEventListener('click', () => onOpen(item.path))
    }
  }
}

/** 渲染最近打开文件列表；列表为空时显示占位文案。
 *  onRemove：行内 hover × 单条移除（不传则不渲染按钮） */
export function renderRecent(
  container: HTMLElement,
  recent: RecentEntry[],
  onOpen: (path: string) => void,
  onRemove?: (path: string) => void,
) {
  container.textContent = ''
  if (!recent.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = t('files.empty')
    container.appendChild(empty)
    return
  }
  for (const item of recent) {
    const row = document.createElement('div')
    row.className = 'tree-file tree-recent'
    row.title = item.path
    const label = document.createElement('span')
    label.className = 'tree-file-name'
    label.textContent = item.name
    row.appendChild(label)
    if (onRemove) {
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'tree-file-remove'
      removeBtn.title = t('files.removeRecent')
      removeBtn.textContent = '×'
      // 阻止冒泡到行的打开动作
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        onRemove(item.path)
      })
      row.appendChild(removeBtn)
    }
    row.addEventListener('click', () => onOpen(item.path))
    container.appendChild(row)
  }
}

/** 已打开文件夹列表行：children 为已懒加载的目录树（未加载时仅可展开触发展加载） */
export interface FolderRow {
  name: string
  path: string
  children?: FileEntry[]
  expanded: boolean
}

/** 渲染已打开文件夹列表（工作区多根）；列表为空时显示占位文案。
 *  - 点击文件夹行：onToggle 展开/收起（子树懒加载由调用方处理后重渲染）
 *  - 子树内文件行点击：onOpen
 *  - onRemove：根行 hover × 单条移除（仅移除侧边栏引用，不删除磁盘文件） */
export function renderFolders(
  container: HTMLElement,
  folders: FolderRow[],
  onOpen: (path: string) => void,
  onToggle: (path: string) => void,
  onRemove?: (path: string) => void,
) {
  container.textContent = ''
  if (!folders.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = t('files.emptyFolder')
    container.appendChild(empty)
    return
  }
  for (const folder of folders) {
    const row = document.createElement('div')
    // 复用 tree-recent 的 flex 布局与 hover × 显隐；tree-folder 提供强调色
    row.className = 'tree-folder tree-recent'
    row.title = folder.path
    const caret = document.createElement('span')
    caret.className = 'tree-caret'
    caret.textContent = folder.expanded ? '▾' : '▸'
    row.appendChild(caret)
    const label = document.createElement('span')
    label.className = 'tree-file-name'
    label.textContent = folder.name
    row.appendChild(label)
    if (onRemove) {
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'tree-file-remove'
      removeBtn.title = t('files.removeFolder')
      removeBtn.textContent = '×'
      // 阻止冒泡到行的展开/收起动作
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        onRemove(folder.path)
      })
      row.appendChild(removeBtn)
    }
    row.addEventListener('click', () => onToggle(folder.path))
    container.appendChild(row)

    // 展开子树：children 已加载时渲染（未加载的条目保持折叠，首次展开时懒加载）
    if (folder.expanded && folder.children) {
      const sub = document.createElement('div')
      renderFileTree(sub, folder.children, onOpen, 1)
      container.appendChild(sub)
    }
  }
}
