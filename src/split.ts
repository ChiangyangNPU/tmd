/**
 * 左右分屏的交互层：分隔条拖拽调宽、点选可编辑侧、两侧滚动近似同步。
 *
 * 视图模式与内容同步的权威在 editor-core（它持有两个编辑器实例），本模块只做
 * DOM 交互，通过 editor-core 暴露的接口驱动，避免把编辑器状态复制一份。
 */
import { getSourceView, getViewMode, setSplitActivePane } from './editor-core'
import { getSplitRatio, setSplitRatio } from './store'

/** 宽度比例上下限：任一侧都不至于窄到不可用 */
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

/** 当前左右宽度比例（左栏占容器宽度的比例） */
let ratio = clampRatio(getSplitRatio())
/** 拖拽进行中 */
let dragging = false
/** 滚动同步进行中：抑制「A 滚 → 设 B → B 触发 scroll → 又设回 A」的回环 */
let syncingScroll = false

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value))
}

/** 把宽度比例写到容器上的 CSS 变量（分屏样式据此分配两栏宽度） */
function applyRatio(value: number) {
  ratio = clampRatio(value)
  document.getElementById('panes')?.style.setProperty('--split-ratio', `${ratio * 100}%`)
}

/** 分隔条拖拽：按住拖动改比例，松手持久化 */
function wireDivider() {
  const divider = document.getElementById('split-divider')
  const panes = document.getElementById('panes')
  if (!divider || !panes) return

  divider.addEventListener('mousedown', (e) => {
    if (getViewMode() !== 'split') return
    e.preventDefault()
    dragging = true
    divider.classList.add('dragging')
    const rect = panes.getBoundingClientRect()
    /** @param {MouseEvent} ev */
    const onMove = (ev: MouseEvent) => {
      if (rect.width > 0) applyRatio((ev.clientX - rect.left) / rect.width)
    }
    const onUp = () => {
      dragging = false
      divider.classList.remove('dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setSplitRatio(ratio)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
}

/**
 * 点选可编辑侧：点哪一侧，哪一侧就可编辑（另一侧转为只读跟随）。
 * 用 mousedown 而非 click——只读侧会吞掉首次点击的默认行为，等到 click 已经晚了。
 */
function wirePaneClick() {
  document.querySelector('.page-scroll')?.addEventListener('mousedown', () => {
    setSplitActivePane('pm')
  })
  document.getElementById('src-pane')?.addEventListener('mousedown', (e) => {
    if (!(e instanceof MouseEvent)) return
    setSplitActivePane('cm', { x: e.clientX, y: e.clientY })
  })
}

/** 可滚动高度比例（无法滚动时为 0，避免除零） */
function scrollRatio(el: HTMLElement): number {
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

/**
 * 两侧滚动近似同步。
 *
 * 按「可滚动高度比例」映射而非行号对齐：源码侧 ```mermaid 块占几行、渲染后是一张
 * 大图，两侧行高本就不同，逐行对齐做不到；比例映射能保证看开头时两边都在开头、
 * 看结尾时两边都在结尾。
 *
 * scroll 事件不冒泡，故挂在 document 捕获阶段——源码栏实例会随模式切换重建，
 * 这样无需重新绑定监听。
 */
function wireScrollSync() {
  document.addEventListener(
    'scroll',
    (e) => {
      if (getViewMode() !== 'split' || syncingScroll || dragging) return
      const cm = getSourceView()
      const pmScroll = document.querySelector('.page-scroll')
      if (!cm || !(pmScroll instanceof HTMLElement)) return
      const from = e.target
      if (from === pmScroll) mirrorScroll(pmScroll, cm.scrollDOM)
      else if (from === cm.scrollDOM) mirrorScroll(cm.scrollDOM, pmScroll)
    },
    true,
  )
}

/**
 * 把 from 的滚动比例映射到 to。
 * 解锁放在下一帧：对方的 scroll 事件在同一帧内派发，早解锁会形成回环。
 * @param {HTMLElement} from @param {HTMLElement} to
 */
function mirrorScroll(from: HTMLElement, to: HTMLElement) {
  syncingScroll = true
  to.scrollTop = scrollRatio(from) * (to.scrollHeight - to.clientHeight)
  requestAnimationFrame(() => {
    syncingScroll = false
  })
}

/** 分屏交互装配（boot 时调用一次） */
export function wireSplit() {
  applyRatio(ratio)
  wireDivider()
  wirePaneClick()
  wireScrollSync()
}
