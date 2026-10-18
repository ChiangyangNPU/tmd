/**
 * 标签栏右键菜单：关闭当前 / 其他 / 左侧 / 右侧 / 已保存 / 全部，以及
 * 「在系统中显示」「复制相对路径 / 复制绝对路径」（复用 files.* 文案与实现）。
 *
 * - 自绘 HTML 菜单：复用编辑区右键菜单的 .more-menu .menu-item 样式与
 *   document click 关外关闭模式，主题 CSS 变量自动跟随深浅色
 * - 各项可用性与关闭目标均为纯函数（tabMenuEnabled / closeTargets，可单测）：
 *   在第一个标签上右键时「关闭左侧」置灰，全部未保存时「关闭已保存」置灰
 * - 「在系统中显示」不是关闭类动作：未保存到磁盘的新文档没有绝对路径、
 *   浏览器降级壳层下无系统文件管理器可用，两种情况都置灰；两个复制项只依赖
 *   标签的文件路径（复制不需要 native），相对路径项另需文件位于某个挂载根下
 * - 批量关闭整批只确认一次（见 tabs.ts closeTabsBulk）；单标签「关闭」走
 *   closeTab 保留按文件名确认的原有文案
 *
 * @author chiangyang
 */
import { listTabs, closeTab, closeTabsBulk } from './tabs'
import { native } from './native'
import { copyPathWithToast, relativeToMountedRoot } from './files'

/** 关闭类动作，DOM 用 data-tm-action 关联（closeTargets 与置灰逻辑只覆盖这些） */
export type TabMenuAction =
  'close' | 'closeOthers' | 'closeLeft' | 'closeRight' | 'closeSaved' | 'closeAll'

/** 全部关闭类菜单项（顺序即显示顺序） */
const ACTIONS: TabMenuAction[] = [
  'close',
  'closeOthers',
  'closeLeft',
  'closeRight',
  'closeSaved',
  'closeAll',
]

/** 非关闭类菜单项：可用性按锚点标签的文件路径单独判定 */
type TabMenuPathAction = 'reveal' | 'copyRelPath' | 'copyAbsPath'

/** 全部非关闭类菜单项（reflectEnabled 按这几项写置灰） */
const PATH_ACTIONS: TabMenuPathAction[] = ['reveal', 'copyRelPath', 'copyAbsPath']

/**
 * 计算菜单各项可用性。
 * @param index 右键标签的位置（列表顺序）；-1 表示已被关闭
 * @param total 当前标签总数
 * @param saved 其中未修改（干净）的标签数
 */
export function tabMenuEnabled(
  index: number,
  total: number,
  saved: number,
): Record<TabMenuAction, boolean> {
  return {
    close: index !== -1,
    closeOthers: total > 1,
    closeLeft: index > 0,
    closeRight: index !== -1 && index < total - 1,
    closeSaved: saved > 0,
    closeAll: total > 0,
  }
}

/**
 * 按动作计算待关闭的标签 id（相对右键的锚点标签）。
 * 锚点不存在（已关闭）时返回空列表，调用方静默忽略。
 */
export function closeTargets(
  action: TabMenuAction,
  anchorId: string,
  tabs: ReadonlyArray<{ id: string; dirty: boolean }>,
): string[] {
  const index = tabs.findIndex((tb) => tb.id === anchorId)
  if (index === -1) return []
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((tb) => tb.id)
  switch (action) {
    case 'close':
      return [tabs[index].id]
    case 'closeOthers':
      return ids(tabs.filter((tb) => tb.id !== anchorId))
    case 'closeLeft':
      return ids(tabs.slice(0, index))
    case 'closeRight':
      return ids(tabs.slice(index + 1))
    case 'closeSaved':
      return ids(tabs.filter((tb) => !tb.dirty))
    case 'closeAll':
      return ids(tabs)
  }
}

/** 把可用性写到菜单项（不可用的置灰，pointer-events:none 不响应点击） */
function reflectEnabled(
  enabled: Record<TabMenuAction, boolean>,
  pathEnabled: Record<TabMenuPathAction, boolean>,
) {
  const menu = document.getElementById('tab-context-menu')
  if (!menu) return
  for (const action of ACTIONS) {
    menu
      .querySelector<HTMLElement>(`[data-tm-action="${action}"]`)
      ?.classList.toggle('disabled', !enabled[action])
  }
  // 路径相关项（在系统中显示 / 复制相对 / 复制绝对）按锚点标签的路径可用性置灰
  for (const action of PATH_ACTIONS) {
    menu
      .querySelector<HTMLElement>(`[data-tm-action="${action}"]`)
      ?.classList.toggle('disabled', !pathEnabled[action])
  }
}

/** 在光标处弹出菜单（视口内钳位）并按当前标签状态置灰 */
function openTabMenu(x: number, y: number, anchorId: string) {
  const menu = document.getElementById('tab-context-menu')
  if (!menu) return
  const tabs = listTabs()
  const index = tabs.findIndex((tb) => tb.id === anchorId)
  const saved = tabs.filter((tb) => !tb.dirty).length
  // 锚点已被关闭时 tabs[index] 为 undefined，路径判空自然置灰
  const path = tabs[index]?.path
  reflectEnabled(tabMenuEnabled(index, tabs.length, saved), {
    // reveal 需要壳层能力；两个复制项只依赖文件路径（浏览器降级也能复制）
    reveal: !!native && !!path,
    copyRelPath: !!path && relativeToMountedRoot(path) !== null,
    copyAbsPath: !!path,
  })
  menu.hidden = false
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
}

/** 关闭菜单（Esc 统一收口等调用） */
export function closeTabMenu(): void {
  const menu = document.getElementById('tab-context-menu')
  if (menu) menu.hidden = true
}

/** 装配标签栏右键菜单（boot 调用一次） */
export function wireTabMenu(): void {
  const bar = document.getElementById('tab-bar')
  const menu = document.getElementById('tab-context-menu')
  if (!bar || !menu) return
  /** 右键命中的标签 id（菜单项点击时回查；期间标签栏若重建，id 已随之失效兜底） */
  let anchorId: string | null = null

  bar.addEventListener('contextmenu', (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>('.tab')
    if (!tabEl?.dataset.tabId) return
    e.preventDefault()
    anchorId = tabEl.dataset.tabId
    openTabMenu(e.clientX, e.clientY, anchorId)
  })

  menu.querySelectorAll<HTMLElement>('[data-tm-action]').forEach((el) => {
    el.addEventListener('click', () => {
      menu.hidden = true
      const action = el.dataset.tmAction as TabMenuAction | TabMenuPathAction
      if (!anchorId) return
      const path = listTabs().find((tb) => tb.id === anchorId)?.path
      // 路径类项不关闭任何标签：「在系统中显示」跳到锚点文件所在文件夹，
      // 两个复制项写入剪贴板（相对路径按挂载根计算，算不出则该项已置灰）
      if (action === 'reveal') {
        if (path) void native?.revealInFolder(path)
        return
      }
      if (action === 'copyAbsPath' || action === 'copyRelPath') {
        if (!path) return
        const value = action === 'copyAbsPath' ? path : relativeToMountedRoot(path)
        if (value !== null) copyPathWithToast(value)
        return
      }
      const ids = closeTargets(action, anchorId, listTabs())
      if (!ids.length) return
      if (action === 'close') {
        void closeTab(ids[0])
      } else {
        // "关闭已保存"可能连锚点一起关，不传锚点；其余动作锚点幸存、关后留在原地
        void closeTabsBulk(ids, action === 'closeSaved' ? undefined : anchorId)
      }
    })
  })

  // 点击菜单外任意位置关闭（与编辑区右键菜单同一模式）
  document.addEventListener('click', (e) => {
    if (!menu || menu.hidden) return
    if (!(e.target as HTMLElement).closest('#tab-context-menu')) menu.hidden = true
  })

  // 编辑区/侧边栏等处右键：先关掉残留菜单（右键不产生 click，仅靠 click 关外会残留；
  // 命中的是标签本身时交给上面的 bar 处理器原地重开，不当作「别处」）
  document.addEventListener('contextmenu', (e) => {
    if (!menu || menu.hidden) return
    const target = e.target as HTMLElement
    if (target.closest('#tab-context-menu') || target.closest('.tab')) return
    menu.hidden = true
  })
}
