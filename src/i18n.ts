/**
 * 轻量 i18n：MarkText 式 JSON 语言包
 *
 * - 语言包在 src/locales/*.json，键为嵌套结构
 * - 默认语言跟随系统，localStorage 'tmd:lang' 可覆盖
 * - 静态 HTML 文案通过 data-i18n（textContent）/ data-i18n-title /
 *   data-i18n-placeholder 属性批量替换；动态文案用 t()
 *
 * @author chiangyang
 */
import zhCN from './locales/zh-CN.json'
import zhHant from './locales/zh-Hant.json'
import en from './locales/en.json'
import { LOCALE_KEY } from './store'

const messages: Record<string, unknown> = {
  'zh-CN': zhCN,
  'zh-Hant': zhHant,
  en,
}

/**
 * 语言检测：localStorage 优先；繁中（台/港/澳）取 zh-Hant，其余 zh 系取 zh-CN，
 * 其他语言一律 en。
 */
function detectLocale(): string {
  const stored = localStorage.getItem(LOCALE_KEY)
  if (stored && messages[stored]) return stored
  const nav = navigator.language
  if (/^zh-(TW|HK|MO|Hant)/i.test(nav)) return 'zh-Hant'
  if (nav.startsWith('zh')) return 'zh-CN'
  return 'en'
}

let currentLocale = detectLocale()

/** 获取当前语言码（'zh-CN' | 'zh-Hant' | 'en'） */
export function getLocale(): string {
  return currentLocale
}

/** 切换并持久化语言；未注册的语言名直接忽略 */
export function setLocale(locale: string) {
  if (!messages[locale]) return
  currentLocale = locale
  localStorage.setItem(LOCALE_KEY, locale)
}

/**
 * 按点分路径从当前语言包中取值。
 * @param path - 点分路径（如 'settings.shortcuts'）
 * @returns 命中的字符串；路径不存在或值非字符串时返回 undefined
 */
function resolve(path: string): string | undefined {
  const value = path
    .split('.')
    .reduce<unknown>(
      (obj, key) =>
        obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined,
      messages[currentLocale],
    )
  return typeof value === 'string' ? value : undefined
}

/** 取词：t('toolbar.find')；支持参数 t('editor.wordCount', { count: 42 }) */
export function t(path: string, params?: Record<string, string | number>): string {
  let text = resolve(path) ?? path
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      text = text.replaceAll(`{${key}}`, String(value))
    }
  }
  return text
}

/** 当前语言的菜单栏文案（发给 Electron 主进程重建菜单） */
export function menuLabels(): Record<string, string> {
  return {
    file: t('menu.file'),
    open: t('menu.open'),
    openFolder: t('menu.openFolder'),
    openRecent: t('menu.openRecent'),
    recentEmpty: t('menu.recentEmpty'),
    clearRecent: t('menu.clearRecent'),
    save: t('menu.save'),
    saveAs: t('menu.saveAs'),
    newTab: t('menu.newTab'),
    closeTab: t('menu.closeTab'),
    autosave: t('menu.autosave'),
    export: t('menu.export'),
    exportHtml: t('menu.exportHtml'),
    exportPdf: t('menu.exportPdf'),
    format: t('menu.format'),
    bold: t('menu.bold'),
    italic: t('menu.italic'),
    strike: t('menu.strike'),
    inlineCode: t('menu.inlineCode'),
    link: t('menu.link'),
    h1: t('menu.h1'),
    h2: t('menu.h2'),
    h3: t('menu.h3'),
    h4: t('menu.h4'),
    h5: t('menu.h5'),
    h6: t('menu.h6'),
    paragraph: t('menu.paragraph'),
    quote: t('menu.quote'),
    codeBlock: t('menu.codeBlock'),
    bulletList: t('menu.bulletList'),
    orderedList: t('menu.orderedList'),
  }
}

/**
 * 批量替换静态 HTML 文案（boot 时与切换语言时各调用一次），
 * 并把当前语言同步到 `<html lang>`——浏览器据此选字形（同一字体下的
 * 简/繁字形差异）、断行规则与屏幕阅读器发音，index.html 里的静态默认值
 * 在 boot 前生效，此处负责纠正。
 */
export function applyDomTexts(root: ParentNode = document) {
  document.documentElement.lang = currentLocale
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as string)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as string)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder as string))
  })
}
