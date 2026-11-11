/**
 * 设置面板——快捷键自定义：列表渲染、按键捕获与冲突校验展示。
 * 持久化与校验逻辑在 shortcuts 模块，本模块只管面板侧 UI 与捕获态。
 */
import { native } from '../native'
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUP_ORDER,
  loadShortcuts,
  saveShortcuts,
  resetShortcuts,
  formatAccelerator,
  eventToAccelerator,
  isValidShortcut,
  isModifierOnly,
  findConflict,
} from '../shortcuts'
import { t } from '../i18n'

/** 快捷键分组显示文案（文件/导出/格式复用菜单词条，编辑器组单独定义） */
const SHORTCUT_GROUP_LABELS: Record<string, string> = {
  file: 'menu.file',
  export: 'menu.export',
  format: 'menu.format',
  editor: 'settings.shortcutGroupEditor',
}

/** 当前处于按键捕获状态的 action（null 表示未捕获） */
let capturingAction: string | null = null

/** 渲染快捷键列表：按分组展示，每行为名称 + 就近错误提示 + 可点击的按键按钮 */
export function renderShortcuts() {
  const container = document.getElementById('shortcuts-list')
  if (!container) return
  const shortcuts = loadShortcuts()
  container.innerHTML = SHORTCUT_GROUP_ORDER.map((group) => {
    const defs = SHORTCUT_DEFS.filter((d) => d.group === group)
    if (!defs.length) return ''
    const rows = defs
      .map(
        (d) =>
          '<div class="shortcut-row">' +
          `<span class="shortcut-label">${t(d.labelKey)}</span>` +
          '<span class="shortcut-error"></span>' +
          `<button type="button" class="shortcut-key" data-action="${d.action}">` +
          `${formatAccelerator(shortcuts[d.action])}</button>` +
          '</div>',
      )
      .join('')
    const title = t(SHORTCUT_GROUP_LABELS[group] ?? group)
    return `<div class="shortcut-group"><div class="shortcut-group-title">${title}</div>${rows}</div>`
  }).join('')
}

/** 退出按键捕获态（仅清理状态与监听，列表重建由调用方决定） */
export function endCapture() {
  capturingAction = null
  document.removeEventListener('keydown', onCaptureKeydown, true)
}

/** 在状态栏提示一条信息，3 秒后自动清除 */
function showShortcutStatus(text: string) {
  const el = document.getElementById('shortcuts-status')
  if (!el) return
  el.textContent = text
  if (text)
    setTimeout(() => {
      if (el.textContent === text) el.textContent = ''
    }, 3000)
}

/** 在指定快捷键行内就近显示错误提示（避免提示被挤到面板底部看不见） */
function showRowError(action: string, text: string) {
  const btn = document.querySelector(`.shortcut-key[data-action="${action}"]`)
  const el = btn?.closest('.shortcut-row')?.querySelector('.shortcut-error')
  if (el) el.textContent = text
}

/** 捕获期间的 keydown 处理器（capture 阶段拦截，避免触发编辑器内快捷键） */
function onCaptureKeydown(e: KeyboardEvent) {
  if (!capturingAction) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    endCapture()
    renderShortcuts()
    return
  }
  const acc = eventToAccelerator(e)
  // 仅按下了修饰键（尚未按主键）时不提交，等待完整组合
  if (isModifierOnly(acc)) return
  const action = capturingAction
  if (!isValidShortcut(acc)) {
    showRowError(action, t('settings.shortcutInvalid'))
    return
  }
  const conflict = findConflict(acc, action, loadShortcuts())
  if (conflict) {
    const def = SHORTCUT_DEFS.find((d) => d.action === conflict)
    showRowError(action, t('settings.shortcutConflict', { name: def ? t(def.labelKey) : conflict }))
    return
  }
  saveShortcuts({ [action]: acc })
  endCapture()
  renderShortcuts()
  // 同步主进程菜单 accelerator，保持两处一致
  native?.syncShortcuts(loadShortcuts())
}

/** 进入按键捕获态：高亮目标按钮并监听下一次组合键 */
function startCapture(action: string) {
  endCapture()
  capturingAction = action
  renderShortcuts()
  document.addEventListener('keydown', onCaptureKeydown, true)
  const btn = document.querySelector(
    `.shortcut-key[data-action="${action}"]`,
  ) as HTMLButtonElement | null
  if (btn) {
    btn.classList.add('capturing')
    btn.textContent = t('settings.shortcutCapture')
  }
}

/** 快捷键区的事件装配（wireSettings 编排调用） */
export function wireShortcutsSection() {
  // 快捷键：点击按键框进入捕获态；点击列表空白处取消捕获
  const shortcutsList = document.getElementById('shortcuts-list')
  shortcutsList?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.shortcut-key') as HTMLButtonElement | null
    if (btn?.dataset.action) {
      startCapture(btn.dataset.action)
    } else {
      endCapture()
      renderShortcuts()
    }
  })
  // 恢复默认快捷键：清空覆盖项并重新同步主进程菜单
  document.getElementById('shortcuts-reset-btn')?.addEventListener('click', () => {
    resetShortcuts()
    endCapture()
    renderShortcuts()
    native?.syncShortcuts(loadShortcuts())
    showShortcutStatus(t('settings.shortcutResetDone'))
  })
}
