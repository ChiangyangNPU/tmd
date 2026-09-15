/**
 * 设置面板：配置反射、语言/主题/自动保存/图片策略的事件装配。
 *
 * 图片策略的状态由本模块持有（粘贴上下文经 getCurrentImageStrategy 读取）。
 */
import { native } from './native'
import type { UpdateStatus } from './native'
import { applyDomTexts, menuLabels, getLocale, setLocale, t } from './i18n'
import { isDarkTheme } from './theme'
import { isAutosaveOn, setAutosaveOn } from './autosave'
import {
  getImageStrategy,
  setImageStrategy,
  getAutoCheckUpdate,
  setAutoCheckUpdate,
  getCustomCss,
  getThemePreset,
  getSourceLineNumbers,
  setSourceLineNumbers,
  getFocusMode,
  getTypewriterMode,
} from './store'
import { changeThemePreset, changeCustomCss } from './theme-presets'
import { reflectTypography, wireTypography } from './typography'
import { setFocusMode, setTypewriterMode } from './writing-modes'
import { renderTabs, updateTitle } from './tabs'
import { currentMarkdown, updateWordCount } from './editor-core'
import type { ImageStrategy } from './paste-image'
import pkg from '../package.json'

/** 粘贴图片存储策略（设置面板配置） */
let imageStrategy: ImageStrategy = getImageStrategy()

/** 粘贴图片上下文读取当前策略（main.ts 装配注入） */
export function getCurrentImageStrategy(): ImageStrategy {
  return imageStrategy
}

/** 源码模式行号开关应用到 DOM（body.src-no-linenos 经 CSS 隐藏 gutter，不触碰编辑器实例） */
export function applySourceLineNumbers() {
  document.body.classList.toggle('src-no-linenos', !getSourceLineNumbers())
}

/** 打开设置面板并反映当前配置值 */
export function openSettings() {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return

  const langRadio = overlay.querySelector(
    `input[name="set-lang"][value="${getLocale()}"]`,
  ) as HTMLInputElement | null
  if (langRadio) langRadio.checked = true
  // 主题列表高亮：按"预设 + 深浅"映射到列表项
  // （default+浅→简约白；default+深→深色；sepia/green→各自预设项）
  const isDark = isDarkTheme()
  const preset = getThemePreset()
  const listItemValue = isDark && preset === 'default' ? 'dark' : preset
  const presetRadio = overlay.querySelector(
    `input[name="set-preset"][value="${listItemValue}"]`,
  ) as HTMLInputElement | null
  if (presetRadio) presetRadio.checked = true
  const autosaveBox = document.getElementById('set-autosave') as HTMLInputElement | null
  if (autosaveBox) {
    autosaveBox.checked = isAutosaveOn() && !!native
    autosaveBox.disabled = !native
  }
  const imgRadio = overlay.querySelector(
    `input[name="set-img"][value="${imageStrategy}"]`,
  ) as HTMLInputElement | null
  if (imgRadio) imgRadio.checked = true
  const cssBox = document.getElementById('set-custom-css') as HTMLTextAreaElement | null
  if (cssBox) cssBox.value = getCustomCss()
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) autoCheckBox.checked = getAutoCheckUpdate()
  const linenoBox = document.getElementById('set-linenos') as HTMLInputElement | null
  if (linenoBox) linenoBox.checked = getSourceLineNumbers()
  const focusBox = document.getElementById('set-focus-mode') as HTMLInputElement | null
  if (focusBox) focusBox.checked = getFocusMode()
  const typewriterBox = document.getElementById('set-typewriter-mode') as HTMLInputElement | null
  if (typewriterBox) typewriterBox.checked = getTypewriterMode()
  // 排版设置反射（typography 模块自持）
  reflectTypography()

  // 关于面板：版本号从 package.json 读取，避免手动同步遗漏
  const versionEl = document.getElementById('about-version')
  if (versionEl) versionEl.textContent = pkg.version

  overlay.hidden = false
}

/** 关闭设置面板 */
export function closeSettings() {
  document.getElementById('settings-overlay')?.setAttribute('hidden', '')
}

/** 设置面板全部控件事件装配（boot 时调用一次） */
export function wireSettings() {
  // 排版区控件由 typography 模块自装
  wireTypography()
  document.getElementById('settings-close')?.addEventListener('click', closeSettings)
  document.getElementById('settings-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings()
  })
  document.querySelectorAll('input[name="set-lang"]').forEach((input) => {
    input.addEventListener('change', () => {
      setLocale((input as HTMLInputElement).value)
      // 语言切换五联动：静态文案 / 标签栏 / 标题 / 字数 / 菜单
      applyDomTexts()
      renderTabs()
      updateTitle()
      updateWordCount(currentMarkdown())
      native?.setLocaleInfo(menuLabels())
    })
  })
  // 主题列表：持久化 + 即时应用（纯 CSS 变量层，不触碰编辑器）；
  // 深色项 = 切换到主界面深色模式
  document.querySelectorAll('input[name="set-preset"]').forEach((input) => {
    input.addEventListener('change', () => {
      changeThemePreset((input as HTMLInputElement).value)
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
  // 源码模式行号开关：持久化 + body class 即时生效（源码模式开着时切换立即变化）
  document.getElementById('set-linenos')?.addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked
    setSourceLineNumbers(enabled)
    document.body.classList.toggle('src-no-linenos', !enabled)
  })
  // 专注 / 打字机模式：writing-modes 模块自持持久化与即时生效
  document.getElementById('set-focus-mode')?.addEventListener('change', (e) => {
    setFocusMode((e.target as HTMLInputElement).checked)
  })
  document.getElementById('set-typewriter-mode')?.addEventListener('change', (e) => {
    setTypewriterMode((e.target as HTMLInputElement).checked)
  })
  document.querySelectorAll('input[name="set-img"]').forEach((input) => {
    input.addEventListener('change', () => {
      imageStrategy = (input as HTMLInputElement).value as ImageStrategy
      setImageStrategy(imageStrategy)
    })
  })

  // ---------- 更新 ----------
  const autoCheckBox = document.getElementById('set-auto-check-update') as HTMLInputElement | null
  if (autoCheckBox) {
    autoCheckBox.addEventListener('change', () => {
      setAutoCheckUpdate(autoCheckBox.checked)
      native?.setAutoCheckUpdate(autoCheckBox.checked)
    })
  }

  const updateCheckBtn = document.getElementById('update-check-btn') as HTMLButtonElement | null
  const updateStatus = document.getElementById('update-status')
  const updateInstallBtn = document.getElementById('update-install-btn') as HTMLButtonElement | null
  updateCheckBtn?.addEventListener('click', () => {
    void native?.checkForUpdates()
  })
  updateInstallBtn?.addEventListener('click', () => {
    native?.installUpdate()
  })

  /** 根据更新状态刷新设置面板文案与按钮可用性 */
  const applyUpdateStatus = (status: UpdateStatus) => {
    if (!updateStatus || !updateCheckBtn || !updateInstallBtn) return
    switch (status.status) {
      case 'idle':
        updateStatus.textContent = ''
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'checking':
        updateStatus.textContent = t('settings.updateChecking')
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'available':
        updateStatus.textContent = t('settings.updateAvailable', { version: status.version })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'not-available':
        updateStatus.textContent = t('settings.updateNotAvailable')
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
      case 'downloading':
        updateStatus.textContent = t('settings.updateDownloading', {
          percent: Math.round(status.percent),
        })
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = true
        break
      case 'downloaded':
        updateStatus.textContent = t('settings.updateDownloaded')
        updateCheckBtn.disabled = true
        updateInstallBtn.hidden = false
        break
      case 'error':
        updateStatus.textContent = t('settings.updateError', { message: status.message })
        updateCheckBtn.disabled = false
        updateInstallBtn.hidden = true
        break
    }
  }
  native?.onUpdateStatus(applyUpdateStatus)

  // 启动时把"启动时自动检查更新"开关同步给主进程
  // （主进程据此决定是否在 app 启动后 5 秒自动检查）
  native?.setAutoCheckUpdate(getAutoCheckUpdate())

  // 关于面板：外部链接交由主进程用系统默认浏览器打开（避免 file:// 内嵌跳转）
  document.querySelectorAll<HTMLAnchorElement>('a[data-external]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      void native?.openExternal(link.href)
    })
  })
}
