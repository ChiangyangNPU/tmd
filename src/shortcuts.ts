/**
 * 快捷键配置模块
 *
 * 定义所有可自定义快捷键的默认值，并提供读写、解析、格式化等辅助函数。
 * 主进程菜单和渲染层 keydown 均从此处读取配置，保证两处一致。
 *
 * 存储键：localStorage 'tmd:shortcuts'，值为 Record<string, string>
 * （action → Electron accelerator 字符串，如 'CmdOrCtrl+B'）
 *
 * @author chiangyang
 */

/** localStorage 存储键 */
export const SHORTCUTS_KEY = 'tmd:shortcuts'

/** 是否 macOS（决定 Mod 键映射与部分默认快捷键，与 link-nav/main 的检测约定一致） */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent ?? '')

/** 单个快捷键的元信息 */
export interface ShortcutDef {
  /** 动作标识（与主进程菜单 action 对应） */
  action: string
  /** 显示名称的完整 i18n 路径（如 menu.bold） */
  labelKey: string
  /** 默认 Electron accelerator 字符串 */
  default: string
  /** 分组（用于设置面板分组展示） */
  group: 'file' | 'export' | 'format' | 'editor'
}

/**
 * 所有可自定义快捷键的默认定义。
 * 注意：accelerator 使用 Electron 格式（CmdOrCtrl 跨平台）。
 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // 文件操作
  { action: 'open', labelKey: 'menu.open', default: 'CmdOrCtrl+O', group: 'file' },
  {
    action: 'open-folder',
    labelKey: 'menu.openFolder',
    default: 'CmdOrCtrl+Shift+O',
    group: 'file',
  },
  { action: 'save', labelKey: 'menu.save', default: 'CmdOrCtrl+S', group: 'file' },
  { action: 'save-as', labelKey: 'menu.saveAs', default: 'CmdOrCtrl+Shift+S', group: 'file' },
  { action: 'new-tab', labelKey: 'menu.newTab', default: 'CmdOrCtrl+T', group: 'file' },
  { action: 'close-tab', labelKey: 'menu.closeTab', default: 'CmdOrCtrl+W', group: 'file' },

  // 导出
  {
    action: 'export-html',
    labelKey: 'menu.exportHtml',
    default: 'CmdOrCtrl+Shift+H',
    group: 'export',
  },
  {
    action: 'export-pdf',
    labelKey: 'menu.exportPdf',
    default: 'CmdOrCtrl+Shift+P',
    group: 'export',
  },

  // 格式
  { action: 'fmt-bold', labelKey: 'menu.bold', default: 'CmdOrCtrl+B', group: 'format' },
  { action: 'fmt-italic', labelKey: 'menu.italic', default: 'CmdOrCtrl+I', group: 'format' },
  { action: 'fmt-mark', labelKey: 'menu.highlight', default: 'CmdOrCtrl+Shift+H', group: 'format' },
  {
    action: 'fmt-sup',
    labelKey: 'menu.superscript',
    default: 'CmdOrCtrl+Shift+=',
    group: 'format',
  },
  { action: 'fmt-sub', labelKey: 'menu.subscript', default: 'CmdOrCtrl+Shift+-', group: 'format' },
  { action: 'fmt-link', labelKey: 'menu.link', default: 'CmdOrCtrl+K', group: 'format' },
  { action: 'fmt-h1', labelKey: 'menu.h1', default: 'CmdOrCtrl+1', group: 'format' },
  { action: 'fmt-h2', labelKey: 'menu.h2', default: 'CmdOrCtrl+2', group: 'format' },
  { action: 'fmt-h3', labelKey: 'menu.h3', default: 'CmdOrCtrl+3', group: 'format' },
  { action: 'fmt-h4', labelKey: 'menu.h4', default: 'CmdOrCtrl+4', group: 'format' },
  { action: 'fmt-h5', labelKey: 'menu.h5', default: 'CmdOrCtrl+5', group: 'format' },
  { action: 'fmt-h6', labelKey: 'menu.h6', default: 'CmdOrCtrl+6', group: 'format' },
  { action: 'fmt-paragraph', labelKey: 'menu.paragraph', default: 'CmdOrCtrl+0', group: 'format' },
  // macOS 上 Cmd+Q 为退出应用，引用改用 Ctrl+Q（与主进程菜单保持一致）
  {
    action: 'fmt-quote',
    labelKey: 'menu.quote',
    default: IS_MAC ? 'Ctrl+Q' : 'CmdOrCtrl+Q',
    group: 'format',
  },
  {
    action: 'fmt-codeblock',
    labelKey: 'menu.codeBlock',
    default: 'CmdOrCtrl+Shift+K',
    group: 'format',
  },
  {
    action: 'fmt-bullet',
    labelKey: 'menu.bulletList',
    default: 'CmdOrCtrl+Shift+8',
    group: 'format',
  },
  {
    action: 'fmt-ordered',
    labelKey: 'menu.orderedList',
    default: 'CmdOrCtrl+Shift+9',
    group: 'format',
  },

  // 编辑器
  {
    action: 'quick-switch',
    labelKey: 'settings.shortcutQuickSwitch',
    default: 'CmdOrCtrl+P',
    group: 'editor',
  },
  { action: 'find', labelKey: 'settings.shortcutFind', default: 'CmdOrCtrl+F', group: 'editor' },
  {
    action: 'search-files',
    labelKey: 'settings.shortcutSearchFiles',
    default: 'CmdOrCtrl+Shift+F',
    group: 'editor',
  },
  {
    action: 'source-mode',
    labelKey: 'settings.shortcutSourceMode',
    default: 'CmdOrCtrl+E',
    group: 'editor',
  },
  {
    action: 'split-view',
    labelKey: 'settings.shortcutSplitView',
    default: 'CmdOrCtrl+Shift+E',
    group: 'editor',
  },
]

/** 快捷键分组展示顺序（显示文案由 settings.ts 按 i18n 映射，本模块保持纯逻辑无 i18n 依赖） */
export const SHORTCUT_GROUP_ORDER: ShortcutDef['group'][] = ['file', 'export', 'format', 'editor']

/**
 * 读取用户自定义的快捷键配置（合并默认值）
 * @returns action → accelerator 的映射
 */
export function loadShortcuts(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const def of SHORTCUT_DEFS) {
    map[def.action] = def.default
  }
  try {
    const stored = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '{}') as Record<string, string>
    for (const def of SHORTCUT_DEFS) {
      if (stored[def.action]) map[def.action] = stored[def.action]
    }
  } catch {
    // JSON 损坏时静默降级为默认值
  }
  return map
}

/**
 * 保存用户自定义的快捷键配置
 * @param overrides action → accelerator 的覆盖映射
 */
export function saveShortcuts(overrides: Record<string, string>): void {
  const current = loadShortcuts()
  const merged = { ...current, ...overrides }
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(merged))
}

/** 重置所有快捷键为默认值 */
export function resetShortcuts(): void {
  localStorage.removeItem(SHORTCUTS_KEY)
}

/**
 * 将键盘事件转为 Electron accelerator 字符串。
 * 用于设置面板的按键捕获与渲染层快捷键匹配。
 *
 * 平台差异：macOS 上 Cmd（metaKey）映射为 CmdOrCtrl、Ctrl 映射为 Ctrl；
 * Windows/Linux 上 Ctrl 映射为 CmdOrCtrl。
 */
export function eventToAccelerator(e: KeyboardEvent): string {
  const parts: string[] = []
  if (IS_MAC) {
    if (e.metaKey) parts.push('CmdOrCtrl')
    if (e.ctrlKey) parts.push('Ctrl')
  } else if (e.ctrlKey) {
    parts.push('CmdOrCtrl')
  }
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  // 只取主键（忽略纯修饰键）
  const key = normalizeKey(e.key)
  if (key) parts.push(key)
  return parts.join('+')
}

/**
 * 将 KeyboardEvent.key 规范化为 Electron accelerator 可识别的形式。
 * 修饰键本身返回空串（主键未按下，不参与组合）。
 */
function normalizeKey(key: string): string {
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return ''
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  // 方向键等功能键保留原名（Electron 支持 ArrowUp 等）
  return key
}

/** 修饰键名集合（用于判断是否仅按下了修饰键） */
const MODIFIER_PARTS = new Set(['CmdOrCtrl', 'CommandOrControl', 'Ctrl', 'Shift', 'Alt'])

/**
 * 判断 accelerator 是否只由修饰键组成（用户尚未按下主键）。
 * 用于设置面板按键捕获时跳过中间状态。
 */
export function isModifierOnly(acc: string): boolean {
  if (!acc) return true
  return acc.split('+').every((p) => MODIFIER_PARTS.has(p))
}

/**
 * 修饰键显示顺序权重（主键恒排最后）。
 *
 * - Windows/Linux：Ctrl → Shift → Alt（如 Ctrl+Shift+O）
 * - macOS：遵循苹果 HIG 的 ⌃⌥⇧⌘ 顺序，Shift 在 Command 之前，
 *   与系统菜单栏、Finder、VS Code 的显示保持一致（如 ⇧⌘O）
 */
const MODIFIER_DISPLAY_ORDER: Record<string, number> = IS_MAC
  ? { Ctrl: 0, Alt: 1, Shift: 2, CmdOrCtrl: 3, CommandOrControl: 3 }
  : { CmdOrCtrl: 0, CommandOrControl: 0, Ctrl: 1, Shift: 2, Alt: 3 }

/** 单个按键片段的显示文本（macOS 用符号，其余用名称） */
function displayPart(part: string): string {
  switch (part) {
    case 'CmdOrCtrl':
    case 'CommandOrControl':
      return IS_MAC ? '⌘' : 'Ctrl'
    case 'Ctrl':
      return IS_MAC ? '⌃' : 'Ctrl'
    case 'Shift':
      return IS_MAC ? '⇧' : 'Shift'
    case 'Alt':
      return IS_MAC ? '⌥' : 'Alt'
    case 'Space':
      return IS_MAC ? '␣' : 'Space'
    default:
      return part
  }
}

/**
 * 将 accelerator 转为界面展示文本。
 *
 * - Windows/Linux：加号连接，Ctrl 在前（Ctrl+Shift+B）
 * - macOS：符号紧凑连接，按苹果 HIG 顺序（⇧⌘B）
 *
 * 修饰键一律按 MODIFIER_DISPLAY_ORDER 重排，主键恒排最后；
 * 因此配置写成 'Shift+CmdOrCtrl+O' 也会显示为 'Ctrl+Shift+O'（mac 上为 '⇧⌘O'）。
 */
export function formatAccelerator(acc: string): string {
  const parts = acc
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const mods = parts
    .filter((p) => p in MODIFIER_DISPLAY_ORDER)
    .sort((a, b) => MODIFIER_DISPLAY_ORDER[a] - MODIFIER_DISPLAY_ORDER[b])
  const keys = parts.filter((p) => !(p in MODIFIER_DISPLAY_ORDER))
  return [...mods, ...keys].map(displayPart).join(IS_MAC ? '' : '+')
}

/**
 * 检查 accelerator 是否可用作快捷键。
 * 必须包含 CmdOrCtrl/Ctrl/Alt 之一：只带 Shift 会与正常输入（大写字母）冲突。
 */
export function isValidShortcut(acc: string): boolean {
  return /(^|\+)(CmdOrCtrl|CommandOrControl|Ctrl|Alt)(\+|$)/.test(acc) && acc.includes('+')
}

/**
 * 检查两个 accelerator 是否冲突（忽略修饰键顺序）。
 */
export function isSameAccelerator(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .split('+')
      .map((p) => p.trim())
      .sort()
      .join('+')
  return norm(a) === norm(b)
}

/**
 * 检测给定 accelerator 是否与其他已配置的快捷键冲突。
 * @param acc 待检测的 accelerator
 * @param excludeAction 排除的动作（正在编辑的那一项）
 * @returns 冲突的动作名，无冲突返回 null
 */
export function findConflict(
  acc: string,
  excludeAction: string,
  shortcuts: Record<string, string>,
): string | null {
  for (const [action, shortcut] of Object.entries(shortcuts)) {
    if (action === excludeAction) continue
    if (isSameAccelerator(acc, shortcut)) return action
  }
  return null
}
