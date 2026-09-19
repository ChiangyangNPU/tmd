/**
 * 静态模板装配：index.html 只保留首屏壳（工具栏 / 侧边栏 / 编辑区），
 * 隐藏的浮层与面板（菜单 / 快速切换 / 搜索 / 历史 / 表格工具栏 / 设置 / 查找·链接栏）
 * 拆分为 src/templates/*.html，构建期经 Vite `?raw` 内联为字符串。
 *
 * 注入机制：index.html 在各块原位置放置原生 `<template data-partial="名">` 占位
 * （惰性、不参与渲染），boot 最早期把占位整体替换为对应 partial 的节点——
 * 必须先于 applyDomTexts（i18n 的 data-i18n 扫描依赖完整 DOM），且各块内部
 * 结构保持原样，CSS 的相邻兄弟选择器（如 .shortcut-group + .shortcut-group）
 * 不受拆分影响。
 *
 * @author chiangyang
 */
import barsHtml from './bars.html?raw'
import historyHtml from './history.html?raw'
import menusHtml from './menus.html?raw'
import quickSwitchHtml from './quick-switch.html?raw'
import searchHtml from './search.html?raw'
import settingsHtml from './settings.html?raw'
import tableToolbarHtml from './table-toolbar.html?raw'

/** partial 名 → HTML 源（与 index.html 中 data-partial 占位一一对应） */
const PARTIALS: Record<string, string> = {
  menus: menusHtml,
  'quick-switch': quickSwitchHtml,
  search: searchHtml,
  history: historyHtml,
  'table-toolbar': tableToolbarHtml,
  settings: settingsHtml,
  bars: barsHtml,
}

/** 把所有 partial 注入 index.html 的对应占位（boot 调用一次，幂等性不做——boot 只跑一次） */
export function installStaticPartials(): void {
  for (const [name, html] of Object.entries(PARTIALS)) {
    const slot = document.querySelector(`template[data-partial="${name}"]`)
    if (!slot) throw new Error(`缺少模板占位：template[data-partial="${name}"]`)
    const parsed = document.createElement('template')
    parsed.innerHTML = html
    slot.replaceWith(...parsed.content.childNodes)
  }
}
