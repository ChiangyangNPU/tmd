/**
 * 设置面板——主题选择：预设 radio 三态映射与文件式主题（外部 CSS 文件）。
 * 内置项与文件主题共用 input[name="set-preset"]，动态项在渲染时单独绑定。
 */
import { native } from '../native'
import { isDarkTheme } from '../theme'
import { getThemePreset, getThemeFile, setThemeFile } from '../store'
import {
  changeThemePreset,
  changeFileTheme,
  applyFileTheme,
  clearFileTheme,
  resolveThemeSelection,
  displayThemeName,
  FILE_THEME_PREFIX,
} from '../theme-presets'
import { showToast } from '../files'
import { t } from '../i18n'

/** 同步主题 radio 高亮：内置预设 / 深色 / 文件主题三态统一映射 */
export function syncPresetRadio(): void {
  const value = resolveThemeSelection(isDarkTheme(), getThemePreset(), getThemeFile())
  document.querySelectorAll<HTMLInputElement>('input[name="set-preset"]').forEach((input) => {
    if (input.value === value) input.checked = true
  })
}

/**
 * 扫描主题目录并把文件主题渲染为 radio 项（每次打开设置/刷新时整体重建）。
 * 浏览器环境无 IPC，整个文件主题区保持隐藏。
 * @returns 最新主题文件名列表（刷新时据此判断当前主题是否已被删除）
 */
export async function renderFileThemes(): Promise<string[]> {
  const area = document.getElementById('set-file-theme-area')
  const container = document.getElementById('set-file-themes')
  if (!area || !container) return []
  if (!native) {
    area.hidden = true
    return []
  }
  area.hidden = false
  const { themes } = await native.listThemes()
  const current = getThemeFile()
  container.replaceChildren()
  for (const theme of themes) {
    const label = document.createElement('label')
    label.className = 'settings-option'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'set-preset'
    radio.value = FILE_THEME_PREFIX + theme.name
    radio.checked = theme.name === current
    radio.addEventListener('change', () => {
      void selectFileTheme(theme.name)
    })
    const span = document.createElement('span')
    // textContent 赋值，文件名不经过 HTML 解析
    span.textContent = displayThemeName(theme.name)
    label.append(radio, span)
    container.appendChild(label)
  }
  return themes.map((theme) => theme.name)
}

/** 选中某个文件式主题：读取 CSS 并注入；读取失败（竞态删除）则提示并重扫 */
async function selectFileTheme(fileName: string): Promise<void> {
  if (!native) return
  const css = await native.readTheme(fileName)
  if (css == null) {
    showToast(t('settings.themeFileMissing', { name: fileName }))
    await renderFileThemes()
    syncPresetRadio()
    return
  }
  changeFileTheme(fileName, css)
}

/**
 * 「刷新」按钮：重新扫描主题目录。
 * - 当前主题文件已被删除：撤出文件主题层（回落内置变量）并提示
 * - 当前主题仍在：重新读取内容并注入（承接外部编辑器的修改）
 */
async function refreshFileThemes(): Promise<void> {
  if (!native) return
  const names = await renderFileThemes()
  const current = getThemeFile()
  if (!current) return
  if (!names.includes(current)) {
    setThemeFile('')
    clearFileTheme()
    showToast(t('settings.themeFileMissing', { name: current }))
    syncPresetRadio()
    return
  }
  // 文件仍在：重载内容（承接外部编辑器的修改）；扫描与读取之间被删的竞态
  // 同样按缺失回落
  const css = await native.readTheme(current)
  if (css == null) {
    setThemeFile('')
    clearFileTheme()
    showToast(t('settings.themeFileMissing', { name: current }))
    syncPresetRadio()
    return
  }
  applyFileTheme(css)
}

/** 主题区的事件装配（wireSettings 编排调用） */
export function wireThemeSection() {
  // 主题列表：持久化 + 即时应用（纯 CSS 变量层，不触碰编辑器）；
  // 深色项 = 切换到主界面深色模式。动态渲染的文件主题 radio 在
  // renderFileThemes() 中单独绑定（changeFileTheme），与此处内置项互斥。
  document.querySelectorAll('input[name="set-preset"]').forEach((input) => {
    input.addEventListener('change', () => {
      changeThemePreset((input as HTMLInputElement).value)
    })
  })
  // 文件式主题：打开主题文件夹（空目录时主进程创建并写入示例主题）
  document.getElementById('themes-open-dir-btn')?.addEventListener('click', () => {
    void native?.openThemesDir().then((ok) => {
      if (!ok) showToast(t('settings.themesOpenFailed'))
    })
  })
  // 刷新：重新扫描主题目录；当前主题被删则回落内置，仍在则重载文件内容
  // （外部编辑器改完 CSS 保存后点此按钮即生效，不做常驻文件监听）
  document.getElementById('themes-refresh-btn')?.addEventListener('click', () => {
    void refreshFileThemes()
  })
}
