/**
 * 主题切换：CSS 变量 + mermaid 主题 + 图表原地重渲。
 *
 * 不再重建编辑器——SVG 内嵌旧主题配色时由 reThemeMermaid() 原地重画，
 * 保住撤销历史、焦点与滚动位置（重建方案的历史遗留问题）。
 */
import { setTheme } from './store'
import { setMermaidTheme, reThemeMermaid } from './mermaid'
import { native } from './native'

/** 串行化：快速连续切换时避免渲染互相踩踏 */
let themeApplying: Promise<void> = Promise.resolve()

/**
 * 切换深浅主题。
 * 入队串行执行，快速连续切换时不会互相踩踏；失败仅记录日志，不中断队列。
 * @param isDark - true 切深色，false 切浅色
 * @returns 本次切换完成的 Promise
 */
export function applyTheme(isDark: boolean): Promise<void> {
  themeApplying = themeApplying
    .then(() => doApplyTheme(isDark))
    .catch((err) => console.error('[tmd] 主题切换失败', err))
  return themeApplying
}

/**
 * 实际执行主题切换。
 * 先切壳层（原生标题栏/窗口底色），等 IPC 返回后渲染层再翻页面——
 * 两者落在同一视觉瞬间，避免"页面已变、标题栏慢半拍"的差异感。
 * @param isDark - true 切深色，false 切浅色
 */
async function doApplyTheme(isDark: boolean) {
  await native?.setThemeSource(isDark)
  // 深色类挂在 <html> 上（而非 body）：与 index.html 首帧防闪内联脚本同挂载点
  document.documentElement.classList.toggle('dark', isDark)
  setTheme(isDark)
  const button = document.getElementById('theme-toggle')
  if (button) button.textContent = isDark ? '☀️' : '🌙'
  setMermaidTheme(isDark ? 'dark' : 'default')
  reThemeMermaid()
}

/** 当前是否深色主题（设置面板反射用） */
export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark')
}
