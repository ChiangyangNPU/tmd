/**
 * 查找栏：DOM 装配与交互（仅所见即所得模式；源码模式用 CodeMirror 自带搜索）
 *
 * 支持正则模式：由栏内的「.*」按钮切换（大小写不敏感固定开启），替换串可用
 * $& / $1-$9 引用捕获组；表达式非法时在计数位置提示，不抛错也不改动文档。
 */
import {
  compileQuery,
  findSetQuery,
  findStep,
  findReplaceCurrent,
  findReplaceAll,
  findClear,
  findState,
  type FindOptions,
} from './find'
import { canEditWysiwyg, getPmView, isSourceMode, onViewModeChange } from './editor-core'
import { t } from './i18n'

/** 正则模式开关（查找栏关闭后仍保留用户上次的选择） */
let regexMode = false

/** 当前生效的查找选项 */
function findOptions(): FindOptions {
  return { regex: regexMode }
}

/** 同步正则按钮的按下态与样式 */
function syncRegexButton() {
  const btn = document.getElementById('find-regex')
  if (!btn) return
  btn.setAttribute('aria-pressed', String(regexMode))
  btn.classList.toggle('active', regexMode)
}

/**
 * 刷新计数展示；invalid 为真时改为提示表达式非法（正则模式下不搜索）。
 * @param invalid - 正则表达式是否非法
 */
function refreshCount(invalid = false) {
  const countEl = document.getElementById('find-count')
  if (!countEl) return
  if (invalid) {
    countEl.textContent = t('find.regexInvalid')
    countEl.classList.add('find-count-error')
    return
  }
  countEl.classList.remove('find-count-error')
  const s = findState()
  countEl.textContent = `${s.matches.length ? s.index + 1 : 0}/${s.matches.length}`
}

/**
 * 执行一次查找并刷新计数。
 * 正则模式下表达式非法时：清掉上次的高亮并提示，不调用 findSetQuery。
 * @param query - 查找词或正则表达式
 */
function runSearch(query: string) {
  const view = getPmView()
  if (!view || !canEditWysiwyg()) return
  if (regexMode && query && !compileQuery(query)) {
    findClear(view)
    refreshCount(true)
    return
  }
  findSetQuery(view, query, findOptions())
  refreshCount()
}

/**
 * 打开查找栏。
 * 两种情形不打开：纯源码模式（交给 CodeMirror 自带搜索）、分屏中源码为编辑侧
 * （所见即所得只读，查找替换会被下一次源码→所见即所得同步覆盖）。
 */
export function openFindBar() {
  const bar = document.getElementById('find-bar')
  if (!bar) return
  if (!canEditWysiwyg()) return
  bar.hidden = false
  syncRegexButton()
  const input = document.getElementById('find-input') as HTMLInputElement | null
  input?.focus()
  // 上次关闭时可能留着关键词：重新搜索一次，避免「框里有词却无高亮、无计数」
  if (input?.value) runSearch(input.value)
}

/**
 * 关闭查找栏并清除高亮。未打开时直接返回——全局 Esc 会无条件调用它，
 * 这里不做拦截就会每次按 Esc 都触发一次装饰重算并抢走焦点。
 * @param restoreFocus - 是否把焦点还给所见即所得编辑器（默认给回）：否则焦点留在
 *   已隐藏的输入框上，用户接着敲字没有任何反应；由模式切换触发的关闭不应抢焦点
 */
export function closeFindBar(restoreFocus = true) {
  const bar = document.getElementById('find-bar')
  if (!bar || bar.hidden) return
  bar.hidden = true
  findClear(isSourceMode() ? null : getPmView())
  if (restoreFocus) getPmView()?.focus()
}

/** 绑定查找栏的输入、上下跳转、替换单个/全部、关闭等交互 */
export function wireFindBar() {
  const findInput = document.getElementById('find-input') as HTMLInputElement | null
  const replaceInput = document.getElementById('replace-input') as HTMLInputElement | null
  // 模式切到不可查找的状态（纯源码 / 分屏中源码为编辑侧）时收起查找栏：
  // 否则输入框与高亮残留，替换还会改到只读的所见即所得侧并被随后同步覆盖
  onViewModeChange(() => {
    if (canEditWysiwyg()) return
    closeFindBar(false)
  })

  findInput?.addEventListener('input', () => {
    runSearch(findInput.value)
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
  document.getElementById('find-regex')?.addEventListener('click', () => {
    regexMode = !regexMode
    syncRegexButton()
    // 切换后按新语义重搜当前关键词（表达式非法则由 runSearch 提示）
    if (findInput?.value) runSearch(findInput.value)
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
  document.getElementById('find-close')?.addEventListener('click', () => closeFindBar())
}
