/**
 * Ctrl/Cmd+滚轮缩放编辑区字号（触控板捏合同路径：Chromium 捏合即 ctrl+wheel）。
 *
 * - 仅编辑区（#panes）内接管：侧边栏、浮层、设置面板上的滚轮不缩放；
 *   preventDefault 阻止 Chromium 的页面缩放默认行为
 * - 每格 ±1px，经 typography.adjustFontSize 持久化（所见即所得与源码模式
 *   共用 --editor-font-size，两视图同步变化）
 * - HUD 单实例：连续滚动原地刷新数值，停止 900ms 后淡出（不用 toast——
 *   连续滚动会堆叠多条 3 秒提示）
 *
 * @author chiangyang
 */
import { adjustFontSize } from './typography'
import { t } from './i18n'

/** HUD 停止滚动后多久淡出 */
const HUD_HIDE_DELAY_MS = 900

let hud: HTMLDivElement | null = null
let hideTimer: number | undefined

/** 原地刷新 HUD 数值；连续滚动只重置淡出计时器 */
function showHud(size: number): void {
  if (!hud) {
    hud = document.createElement('div')
    hud.className = 'font-zoom-hud'
    document.body.appendChild(hud)
  }
  hud.textContent = t('settings.fontZoom', { size })
  hud.classList.add('visible')
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => hud?.classList.remove('visible'), HUD_HIDE_DELAY_MS)
}

/** 滚轮事件装配（boot 调用一次；浏览器模式同样可用） */
export function wireFontZoom(): void {
  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as Element | null
      if (!target?.closest?.('#panes')) return
      e.preventDefault()
      showHud(adjustFontSize(e.deltaY < 0 ? 1 : -1))
    },
    { passive: false },
  )
}
