/**
 * 查找栏：DOM 装配与交互（仅所见即所得模式；源码模式用 CodeMirror 自带搜索）
 */
import {
  findSetQuery,
  findStep,
  findReplaceCurrent,
  findReplaceAll,
  findClear,
  findState,
} from './find'
import { getPmView, isSourceMode } from './editor-core'

/** 打开查找栏（源码模式下不打开，留给 CodeMirror 搜索） */
export function openFindBar() {
  const bar = document.getElementById('find-bar')
  if (!bar) return
  if (isSourceMode()) return
  bar.hidden = false
  ;(document.getElementById('find-input') as HTMLInputElement | null)?.focus()
}

/** 关闭查找栏并清除高亮 */
export function closeFindBar() {
  const bar = document.getElementById('find-bar')
  if (bar) bar.hidden = true
  findClear(isSourceMode() ? null : getPmView())
}

/** 绑定查找栏的输入、上下跳转、替换单个/全部、关闭等交互 */
export function wireFindBar() {
  const findInput = document.getElementById('find-input') as HTMLInputElement | null
  const replaceInput = document.getElementById('replace-input') as HTMLInputElement | null
  const countEl = document.getElementById('find-count')

  function refreshCount() {
    const s = findState()
    if (countEl) countEl.textContent = `${s.matches.length ? s.index + 1 : 0}/${s.matches.length}`
  }

  findInput?.addEventListener('input', () => {
    const pmView = getPmView()
    if (!pmView || isSourceMode()) return
    findSetQuery(pmView, findInput.value)
    refreshCount()
  })
  findInput?.addEventListener('keydown', (e) => {
    // IME 组字期间回车用于确认候选词，不应触发查找跳转
    if (e.isComposing) return
    const pmView = getPmView()
    if (e.key === 'Enter' && pmView) {
      e.preventDefault()
      findStep(pmView, e.shiftKey ? -1 : 1)
      refreshCount()
    }
    if (e.key === 'Escape') closeFindBar()
  })
  document.getElementById('find-next')?.addEventListener('click', () => {
    const pmView = getPmView()
    if (pmView) {
      findStep(pmView, 1)
      refreshCount()
    }
  })
  document.getElementById('find-prev')?.addEventListener('click', () => {
    const pmView = getPmView()
    if (pmView) {
      findStep(pmView, -1)
      refreshCount()
    }
  })
  document.getElementById('replace-one')?.addEventListener('click', () => {
    const pmView = getPmView()
    if (pmView && replaceInput) {
      findReplaceCurrent(pmView, replaceInput.value)
      refreshCount()
    }
  })
  document.getElementById('replace-all')?.addEventListener('click', () => {
    const pmView = getPmView()
    if (pmView && replaceInput) {
      findReplaceAll(pmView, replaceInput.value)
      refreshCount()
    }
  })
  document.getElementById('find-close')?.addEventListener('click', closeFindBar)
}
