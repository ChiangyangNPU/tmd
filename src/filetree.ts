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

/** 行右键菜单目标：entry + 鼠标位置 + 行内编辑所需的容器引用 */
export interface FolderMenuTarget {
  entry: FileEntry
  x: number
  y: number
  /** 目录行展开后的子树容器（目录行才有；行内新建输入插到它顶部） */
  subContainer: HTMLElement | null
  /** 整棵树容器（重命名按路径在其中定位行） */
  treeContainer: HTMLElement
  /** 该行在树中的缩进层级（根行为 0，行内新建输入框据此计算缩进） */
  depth: number
}

/** 递归渲染目录树：目录行点击经 onToggleDir 展开/收起（子树由调用方懒加载后重渲染），
 *  文件行点击触发 onOpen 回调。
 *  onMenu：行右键菜单（文件管理），不传则无右键行为
 *  expandedPaths：当前已展开的目录路径集合；未传时目录行不可展开（只读静态树场景） */
export function renderFileTree(
  container: HTMLElement,
  entries: FileEntry[],
  onOpen: (path: string) => void,
  depth = 0,
  onMenu?: (target: FolderMenuTarget) => void,
  expandedPaths?: Set<string>,
  onToggleDir?: (path: string) => void | Promise<void>,
) {
  for (const item of entries) {
    const isDir = !!item.children
    const row = document.createElement('div')
    row.className = isDir ? 'tree-folder' : 'tree-file'
    row.style.paddingLeft = `${8 + depth * 14}px`
    row.title = item.path
    if (isDir) {
      // 折叠箭头：展开状态完全由 expandedPaths 驱动（重渲染后保持）
      const caret = document.createElement('span')
      caret.className = 'tree-caret'
      const expanded = expandedPaths?.has(item.path) ?? false
      caret.textContent = expanded ? '▾' : '▸'
      row.appendChild(caret)
    }
    // 名称放 .tree-file-name 标签：行内重命名靠它替换输入框（与根行/最近行同构）
    const label = document.createElement('span')
    label.className = 'tree-file-name'
    label.textContent = item.name
    row.appendChild(label)
    if (onMenu) {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sub = row.nextElementSibling?.classList.contains('folder-sub')
          ? (row.nextElementSibling as HTMLElement)
          : null
        onMenu({
          entry: item,
          x: e.clientX,
          y: e.clientY,
          subContainer: sub,
          treeContainer: container,
          depth,
        })
      })
    }
    container.appendChild(row)

    if (isDir) {
      // 展开/收起与懒加载统一交调用方处理：本函数只反映 expandedPaths 的状态
      row.addEventListener('click', () => {
        void onToggleDir?.(item.path)
      })
      if (expandedPaths?.has(item.path)) {
        const sub = document.createElement('div')
        sub.className = 'folder-sub'
        container.appendChild(sub)
        renderFileTree(
          sub,
          item.children ?? [],
          onOpen,
          depth + 1,
          onMenu,
          expandedPaths,
          onToggleDir,
        )
      }
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

/** 文件管理回调（全部可选；不传则侧边栏保持只读，浏览器降级即此形态） */
export interface FolderManageCallbacks {
  /** 在 dir 下新建文件/文件夹（名称来自行内输入；提交后由调用方刷新树） */
  onCreate: (dir: string, kind: 'file' | 'dir', name: string) => void
  /** 重命名（同目录内）；成功后由调用方刷新树并同步打开标签 */
  onRename: (path: string, newName: string) => void
  /** 在系统文件管理器中显示 */
  onReveal: (path: string) => void
  /** 行右键菜单 */
  onMenu: (target: FolderMenuTarget) => void
}

/** 行内输入框（新建 / 重命名共用）：Enter 提交、Esc 取消、失焦取消。
 *  done 幂等闩：移除聚焦中的 input 会同步触发 blur，重入的收尾必须被挡住
 *  （否则 row.remove() 重入抛 NotFoundError，提交链路被异常打断） */
function beginInlineEdit(
  row: HTMLElement,
  initialName: string,
  selectBase: boolean,
  onSubmit: (name: string) => void,
): void {
  const label = row.querySelector<HTMLElement>('.tree-file-name')
  if (!label || row.querySelector('.tree-inline-input')) return
  const input = document.createElement('input')
  input.className = 'tree-inline-input'
  input.value = initialName
  let done = false
  const finish = (submit: boolean) => {
    if (done) return
    done = true
    const name = input.value
    input.remove()
    row.remove()
    label.style.display = ''
    if (submit && name.trim()) onSubmit(name)
  }
  // 重命名选中主名（不含扩展名）；新建全选便于直接输入
  const baseLen = selectBase ? initialName.replace(/\.md$/i, '').length : initialName.length
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(false))
  label.style.display = 'none'
  row.appendChild(input)
  input.focus()
  input.setSelectionRange(0, baseLen)
}

/** 新建入口的行内输入：在树容器顶部插入一行输入（Enter 提交 / Esc 或失焦取消） */
export function beginInlineCreate(
  container: HTMLElement,
  depth: number,
  onSubmit: (name: string) => void,
): void {
  if (container.querySelector('.tree-inline-row')) return
  const row = document.createElement('div')
  row.className = 'tree-file tree-recent tree-inline-row'
  row.style.paddingLeft = `${8 + depth * 14}px`
  const input = document.createElement('input')
  input.className = 'tree-inline-input'
  input.placeholder = t('files.newNamePlaceholder')
  let done = false
  const finish = (submit: boolean) => {
    if (done) return
    done = true
    const name = input.value
    input.remove()
    row.remove()
    if (submit && name.trim()) onSubmit(name)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(false))
  row.appendChild(input)
  container.prepend(row)
  input.focus()
}

/** 渲染已打开文件夹列表（工作区多根）；列表为空时显示占位文案。
 *  - 点击文件夹行：onToggle 展开/收起（子树懒加载由调用方处理后重渲染）
 *  - 子树内文件行点击：onOpen
 *  - onRemove：根行 hover × 单条移除（仅移除侧边栏引用，不删除磁盘文件）
 *  - manage：文件管理能力（根行 ＋新建按钮 / 行右键菜单），不传则只读 */
export function renderFolders(
  container: HTMLElement,
  folders: FolderRow[],
  onOpen: (path: string) => void,
  onToggle: (path: string) => void | Promise<void>,
  onRemove?: (path: string) => void,
  manage?: FolderManageCallbacks,
  /** 当前展开的目录路径集合（根 + 各层级子目录共用），透传给子树控制展开状态 */
  expandedPaths?: Set<string>,
) {
  container.textContent = ''
  if (!folders.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = t('files.emptyFolder')
    container.appendChild(empty)
    return
  }
  /** 按根路径在当前渲染结果中定位其子树容器（重渲染后旧引用失效，需重新查找） */
  const findSubOf = (rootPath: string): HTMLElement | null => {
    const rootRow = [...container.querySelectorAll<HTMLElement>('.tree-folder')].find(
      (el) => el.title === rootPath,
    )
    const next = rootRow?.nextElementSibling
    return next?.classList.contains('folder-sub') ? (next as HTMLElement) : null
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
    if (manage) {
      // 根行 hover ＋新建按钮（文件 / 文件夹）：行内输入 → onCreate 提交
      for (const kind of ['file', 'dir'] as const) {
        const addBtn = document.createElement('button')
        addBtn.type = 'button'
        addBtn.className = `tree-file-remove tree-dir-add tree-dir-add-${kind}`
        addBtn.title = kind === 'file' ? t('files.newFile') : t('files.newFolder')
        addBtn.textContent = kind === 'file' ? '＋文' : '＋夹'
        addBtn.addEventListener('click', async (e) => {
          e.stopPropagation()
          let sub = findSubOf(folder.path)
          // 未展开：先等懒加载展开与重渲染完成，再重新定位子树容器。
          // 不能在旧容器上预插输入行——异步 readDir 回来后的整树重渲染会把它清掉
          if (!sub) {
            await onToggle(folder.path)
            sub = findSubOf(folder.path)
          }
          if (sub) beginInlineCreate(sub, 1, (name) => manage.onCreate(folder.path, kind, name))
        })
        row.appendChild(addBtn)
      }
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sub = row.nextElementSibling?.classList.contains('folder-sub')
          ? (row.nextElementSibling as HTMLElement)
          : null
        manage.onMenu({
          entry: { name: folder.name, path: folder.path, children: folder.children },
          x: e.clientX,
          y: e.clientY,
          subContainer: sub,
          treeContainer: container,
          depth: 0,
        })
      })
    }
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
    row.addEventListener('click', () => void onToggle(folder.path))
    container.appendChild(row)

    // 展开子树：children 已加载时渲染（未加载的条目保持折叠，首次展开时懒加载）
    if (folder.expanded && folder.children) {
      const sub = document.createElement('div')
      sub.className = 'folder-sub'
      renderFileTree(sub, folder.children, onOpen, 1, manage?.onMenu, expandedPaths, onToggle)
      container.appendChild(sub)
    }
  }
}

/** 行内重命名入口（文件行 / 文件夹行右键菜单调用）：label 换输入框 */
export function beginRename(
  container: HTMLElement,
  path: string,
  onSubmit: (name: string) => void,
): boolean {
  // 按路径找行：title 属性携带绝对路径（根行 / 文件行均有）
  const row = [...container.querySelectorAll<HTMLElement>('[title]')].find(
    (el) => el.title === path,
  )
  if (!row) return false
  const label = row.querySelector<HTMLElement>('.tree-file-name')
  const name = label?.textContent ?? ''
  beginInlineEdit(row, name, true, onSubmit)
  return true
}
