/**
 * 设置面板框架：分类导航联动、拖拽移动、开合反射与全部区块的事件编排。
 * 各配置域的实现在同目录子模块（image / ai / shortcuts / theme-files /
 * update），本模块只负责装配顺序与面板自身行为，保持与原 settings.ts
 * 相同的绑定顺序。
 */
import { native } from '../native'
import { applyDomTexts, menuLabels, getLocale, setLocale, t } from '../i18n'
import { isAutosaveOn, setAutosaveOn } from '../autosave'
import {
  getAutoCheckUpdate,
  getCustomCss,
  getSourceLineNumbers,
  setSourceLineNumbers,
  getSpellcheckEnabled,
  setSpellcheckEnabled,
  getFocusMode,
  getTypewriterMode,
  getPdfOptions,
  setPdfOptions,
  getHtmlOffline,
  setHtmlOffline,
} from '../store'
import type { PdfOptions } from '../pdf-options'
import { changeCustomCss } from '../theme-presets'
import { reflectTypography, wireTypography } from '../typography'
import { setFocusMode, setTypewriterMode } from '../writing-modes'
import { renderTabs, updateTitle } from '../tabs'
import { reloadFolderTrees, showToast } from '../files'
import { currentMarkdown, updateWordCount } from '../editor-core'
import pkg from '../../package.json'
import { degradePicGoOption, getCurrentImageStrategy, loadPicGoConfig, togglePicGoSection, wireImageSection } from './image'
import { loadAiConfig, resetAiFormDirty, wireAiSection } from './ai'
import { endCapture, renderShortcuts, wireShortcutsSection } from './shortcuts'
import { renderFileThemes, syncPresetRadio, wireThemeSection } from './theme-files'
import { wireUpdateSection } from './update'

/** 源码模式行号开关应用到 DOM（body.src-no-linenos 经 CSS 隐藏 gutter，不触碰编辑器实例） */
export function applySourceLineNumbers() {
  document.body.classList.toggle('src-no-linenos', !getSourceLineNumbers())
}

/**
 * 拼写检查开关应用到 DOM：写在编辑区容器 #panes 上，动态创建的
 * ProseMirror / CodeMirror 可编辑根经 spellcheck 属性继承获得，无需重建编辑器。
 * Chromium 对可编辑内容默认开启，因此必须显式写 true/false，不能移除属性。
 */
export function applySpellcheck() {
  document.getElementById('panes')?.setAttribute('spellcheck', String(getSpellcheckEnabled()))
}

/** 导航分类 → 该类包含的区块 id（按 DOM 顺序排列；点击定位到首个区块） */
const NAV_SECTIONS: { target: string; sections: string[] }[] = [
  { target: 'sec-theme', sections: ['sec-theme', 'sec-css', 'sec-lang'] },
  { target: 'sec-typography', sections: ['sec-typography'] },
  { target: 'sec-linenos', sections: ['sec-linenos', 'sec-spellcheck', 'sec-writing'] },
  { target: 'sec-autosave', sections: ['sec-autosave', 'sec-image', 'picgo-config-section'] },
  { target: 'sec-ai', sections: ['sec-ai'] },
  { target: 'sec-shortcuts', sections: ['sec-shortcuts'] },
  { target: 'sec-update', sections: ['sec-update', 'logs-section'] },
  { target: 'sec-about', sections: ['sec-about'] },
]

/**
 * 装配分类导航：点击平滑定位，滚动时左侧高亮自动跟随。
 * 跟随判定取「顶部已越过内容窗顶部（32px 容差）」的最后一个区块；
 * display:none 的区块（图床配置按策略显隐、浏览器下日志区隐藏）不参与定位。
 * 滚到底部时末尾区块可能够不到顶部阈值（下方内容不足一屏），强制落末类。
 */
function wireSettingsNav() {
  const content = document.getElementById('settings-content')
  const items = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item'),
  )
  if (!content || !items.length) return
  const sectionEls = NAV_SECTIONS.flatMap((cat) => cat.sections)
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el)
  const categoryOf = new Map<string, string>()
  for (const cat of NAV_SECTIONS) for (const sid of cat.sections) categoryOf.set(sid, cat.target)
  const setActive = (target: string) =>
    items.forEach((it) => it.classList.toggle('active', it.dataset.navTarget === target))

  items.forEach((it) => {
    it.addEventListener('click', () => {
      const target = it.dataset.navTarget
      const el = target ? document.getElementById(target) : null
      if (!el || !target) return
      setActive(target)
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  content.addEventListener('scroll', () => {
    let current = NAV_SECTIONS[0].target
    for (const s of sectionEls) {
      if (!s.offsetParent) continue
      if (s.offsetTop - content.scrollTop > 32) break
      current = categoryOf.get(s.id) ?? current
    }
    const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 4
    if (atBottom) {
      for (let i = sectionEls.length - 1; i >= 0; i--) {
        if (sectionEls[i].offsetParent) {
          current = categoryOf.get(sectionEls[i].id) ?? current
          break
        }
      }
    }
    setActive(current)
  })
}

/**
 * 设置面板拖拽移动：按住标题栏拖动（关闭按钮不作为拖拽把手）。
 * 首次拖动时把面板从 overlay 的 flex 居中切换为 fixed 定位，此后由 left/top 控制；
 * 位置始终约束在视口内，每次重新打开时清除内联样式恢复居中。
 */
function wireSettingsDrag() {
  const overlay = document.getElementById('settings-overlay')
  const modal = overlay?.querySelector('.settings-modal') as HTMLElement | null
  const header = overlay?.querySelector('.settings-header') as HTMLElement | null
  if (!overlay || !modal || !header) return
  let dragging = false
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0

  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    // 关闭按钮照常点击，不触发拖拽
    if (e.target instanceof HTMLElement && e.target.closest('#settings-close')) return
    const rect = modal.getBoundingClientRect()
    modal.style.position = 'fixed'
    modal.style.margin = '0'
    modal.style.left = `${rect.left}px`
    modal.style.top = `${rect.top}px`
    dragging = true
    startX = e.clientX
    startY = e.clientY
    startLeft = rect.left
    startTop = rect.top
    // 指针捕获：拖动经过编辑器等区域时事件仍保持在标题栏上
    header.setPointerCapture(e.pointerId)
    e.preventDefault()
  })
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const left = Math.min(
      Math.max(startLeft + e.clientX - startX, 0),
      Math.max(window.innerWidth - modal.offsetWidth, 0),
    )
    const top = Math.min(
      Math.max(startTop + e.clientY - startY, 0),
      Math.max(window.innerHeight - modal.offsetHeight, 0),
    )
    modal.style.left = `${left}px`
    modal.style.top = `${top}px`
  })
  const endDrag = () => {
    dragging = false
  }
  header.addEventListener('pointerup', endDrag)
  header.addEventListener('pointercancel', endDrag)
}

/** 打开设置面板并反映当前配置值 */
export function openSettings() {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return

  // 每次打开恢复居中：清除上次拖拽遗留的内联定位
  const modal = overlay.querySelector('.settings-modal') as HTMLElement | null
  if (modal) {
    modal.style.position = ''
    modal.style.margin = ''
    modal.style.left = ''
    modal.style.top = ''
  }

  const langRadio = overlay.querySelector(
    `input[name="set-lang"][value="${getLocale()}"]`,
  ) as HTMLInputElement | null
  if (langRadio) langRadio.checked = true
  // 主题列表高亮：内置预设 / 深色 / 文件主题三态统一由纯函数映射
  syncPresetRadio()
  // 文件式主题：Electron 环境下扫描主题目录渲染外部 radio 项
  void renderFileThemes()
  const autosaveBox = document.getElementById('set-autosave') as HTMLInputElement | null
  if (autosaveBox) {
    autosaveBox.checked = isAutosaveOn() && !!native
    autosaveBox.disabled = !native
  }
  // 图床能力降级须先于单选项同步：已存 hosting 策略在此回落到 inline，
  // 下面的 imgRadio 才能选中真正生效的那一项
  degradePicGoOption()
  const imgRadio = overlay.querySelector(
    `input[name="set-img"][value="${getCurrentImageStrategy()}"]`,
  ) as HTMLInputElement | null
  if (imgRadio) imgRadio.checked = true
  const cssBox = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
  if (cssBox) cssBox.value = getCustomCss()
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) autoCheckBox.checked = getAutoCheckUpdate()
  const linenoBox = document.getElementById('set-linenos') as HTMLInputElement | null
  if (linenoBox) linenoBox.checked = getSourceLineNumbers()
  const spellcheckBox = document.getElementById('set-spellcheck') as HTMLInputElement | null
  if (spellcheckBox) spellcheckBox.checked = getSpellcheckEnabled()
  const focusBox = document.getElementById('set-focus-mode') as HTMLInputElement | null
  if (focusBox) focusBox.checked = getFocusMode()
  const typewriterBox = document.getElementById('set-typewriter-mode') as HTMLInputElement | null
  if (typewriterBox) typewriterBox.checked = getTypewriterMode()
  // 排版设置反射（typography 模块自持）
  reflectTypography()

  // 关于面板：版本号从 package.json 读取，避免手动同步遗漏
  const versionEl = document.getElementById('about-version')
  if (versionEl) versionEl.textContent = pkg.version

  // 更新面板：当前版本号与「关于」同源（package.json），便于用户在检查更新前确认本机版本
  const updateVersionEl = document.getElementById('update-version')
  if (updateVersionEl) updateVersionEl.textContent = pkg.version

  // 关于面板：版权年份为「首次发布年份 - 最近发布年份」，起始年固定，结束年随当前年份自动更新
  const copyrightEl = document.getElementById('about-copyright')
  if (copyrightEl) {
    const startYear = 2026
    const currentYear = new Date().getFullYear()
    copyrightEl.textContent = `© ${startYear}${
      currentYear > startYear ? `-${currentYear}` : ''
    } chiangyang`
  }

  // 图床配置：加载并根据图片策略显示/隐藏
  togglePicGoSection()
  void loadPicGoConfig()

  // AI 助手配置：重置表单脏标记后异步回填（用户在回填完成前的修改不会被覆盖）
  resetAiFormDirty()
  void loadAiConfig()

  // 快捷键列表：按当前配置渲染
  renderShortcuts()

  // 打开时回到顶部并高亮第一类：保留上次滚动位置会显得面板「没刷新」
  const content = document.getElementById('settings-content')
  if (content) content.scrollTop = 0
  document.querySelectorAll('#settings-nav .settings-nav-item').forEach((it, idx) => {
    it.classList.toggle('active', idx === 0)
  })

  overlay.hidden = false
}

/** 关闭设置面板 */
export function closeSettings() {
  endCapture()
  document.getElementById('settings-overlay')?.setAttribute('hidden', '')
}

/** 设置面板全部控件事件装配（boot 时调用一次） */
export function wireSettings() {
  // 排版区控件由 typography 模块自装
  wireTypography()
  // 分类导航：点击定位 + 滚动高亮跟随
  wireSettingsNav()
  document.getElementById('settings-close')?.addEventListener('click', closeSettings)
  // 面板只能通过关闭按钮或 ESC 关闭：点击面板外空白区域不关闭
  wireSettingsDrag()
  document.querySelectorAll('input[name="set-lang"]').forEach((input) => {
    input.addEventListener('change', () => {
      setLocale((input as HTMLInputElement).value)
      // 语言切换六联动：静态文案 / <html lang> / 标签栏 / 标题 / 字数 / 菜单与排序
      applyDomTexts()
      renderTabs()
      updateTitle()
      updateWordCount(currentMarkdown())
      native?.setLocaleInfo({ labels: menuLabels(), locale: getLocale() })
      // 文件名排序随界面语言变化，已加载的目录树需按新规则重读
      void reloadFolderTrees()
      // 文件主题列表同样按新语言区域排序，重扫一次
      void renderFileThemes()
    })
  })
  wireThemeSection()
  // 日志与诊断：整个小节仅桌面环境存在（浏览器无本地目录 / IPC）
  if (!native) document.getElementById('logs-section')?.setAttribute('hidden', '')
  document.getElementById('logs-open-dir-btn')?.addEventListener('click', () => {
    void native?.openLogsDir().then((ok) => {
      if (!ok) showToast(t('settings.logsOpenFailed'))
    })
  })
  // 自定义 CSS：输入即应用（防抖交给 input 事件天然节流），「恢复默认」清空
  const cssBox = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
  if (cssBox) {
    cssBox.addEventListener('input', () => {
      changeCustomCss(cssBox.value)
    })
  }
  document.getElementById('css-reset-btn')?.addEventListener('click', () => {
    const box = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
    if (box) {
      box.value = ''
      changeCustomCss('')
    }
  })
  document.getElementById('set-autosave')?.addEventListener('change', (e) => {
    setAutosaveOn((e.target as HTMLInputElement).checked)
  })
  // PDF 导出选项：持久化到 localStorage，导出时读取；主进程再做一次白名单收窄
  const pdfPageSize = document.getElementById('pdf-page-size') as HTMLSelectElement | null
  const pdfOrientation = document.getElementById('pdf-orientation') as HTMLSelectElement | null
  const pdfMargin = document.getElementById('pdf-margin') as HTMLSelectElement | null
  const pdfHeaderFooter = document.getElementById('pdf-header-footer') as HTMLInputElement | null
  const pdfPageNumbers = document.getElementById('pdf-page-numbers') as HTMLInputElement | null
  const pdfOutline = document.getElementById('pdf-outline') as HTMLInputElement | null
  const pdfOptions = getPdfOptions()
  if (pdfPageSize) pdfPageSize.value = pdfOptions.pageSize
  if (pdfOrientation) pdfOrientation.value = pdfOptions.orientation
  if (pdfMargin) pdfMargin.value = pdfOptions.margin
  if (pdfHeaderFooter) pdfHeaderFooter.checked = pdfOptions.headerFooter
  if (pdfPageNumbers) pdfPageNumbers.checked = pdfOptions.pageNumbers
  if (pdfOutline) pdfOutline.checked = pdfOptions.outline
  const savePdfOptions = () => {
    if (!pdfPageSize || !pdfOrientation || !pdfMargin) return
    setPdfOptions({
      pageSize: pdfPageSize.value as PdfOptions['pageSize'],
      orientation: pdfOrientation.value as PdfOptions['orientation'],
      margin: pdfMargin.value as PdfOptions['margin'],
      headerFooter: pdfHeaderFooter?.checked ?? false,
      pageNumbers: pdfPageNumbers?.checked ?? false,
      outline: pdfOutline?.checked ?? true,
    })
  }
  for (const el of [
    pdfPageSize,
    pdfOrientation,
    pdfMargin,
    pdfHeaderFooter,
    pdfPageNumbers,
    pdfOutline,
  ]) {
    el?.addEventListener('change', savePdfOptions)
  }
  // 离线 HTML：开启后导出时内联 Mermaid/KaTeX 资源（约 4–5MB）
  const htmlOffline = document.getElementById('html-offline') as HTMLInputElement | null
  if (htmlOffline) {
    htmlOffline.checked = getHtmlOffline()
    htmlOffline.addEventListener('change', () => {
      setHtmlOffline(htmlOffline.checked)
    })
  }
  // 源码模式行号开关：持久化 + body class 即时生效（源码模式开着时切换立即变化）
  document.getElementById('set-linenos')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked
    setSourceLineNumbers(enabled)
    document.body.classList.toggle('src-no-linenos', !enabled)
  })
  // 拼写检查开关：持久化 + 容器 spellcheck 属性即时生效（可编辑根经继承获得，无需重建）
  document.getElementById('set-spellcheck')?.addEventListener('change', (e) => {
    setSpellcheckEnabled((e.target as HTMLInputElement).checked)
    applySpellcheck()
  })
  // 专注 / 打字机模式：writing-modes 模块自持持久化与即时生效
  document.getElementById('set-focus-mode')?.addEventListener('change', (e) => {
    setFocusMode((e.target as HTMLInputElement).checked)
  })
  document.getElementById('set-typewriter-mode')?.addEventListener('change', (e) => {
    setTypewriterMode((e.target as HTMLInputElement).checked)
  })
  wireImageSection()
  wireAiSection()
  wireShortcutsSection()
  wireUpdateSection()

  // 关于面板：外部链接交由主进程用系统默认浏览器打开（避免 file:// 内嵌跳转）
  document.querySelectorAll<HTMLAnchorElement>('a[data-external]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      void native?.openExternal(link.href)
    })
  })
}
