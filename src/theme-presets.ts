/**
 * 主题预设、文件式主题与自定义 CSS
 *
 * 三层覆盖链（优先级从低到高，全部是纯 CSS 层、不触碰编辑器实例）：
 * - 预设是一组 CSS 变量覆盖，经 <style id="theme-preset-style"> 注入；
 *   浅色变量限定 html[data-theme-preset]:not(.dark)，深色限定
 *   html[data-theme-preset].dark——保证深浅模式各自正确覆盖且不串扰
 * - 文件式主题经 <style id="theme-file-style"> 注入，位于预设之后：
 *   主题为 ~/.tmd/themes/*.css（用户自制，文件内容原样注入，作者自负深浅），
 *   与内置预设互斥；选中时预设层回落 default
 * - 自定义 CSS 经 <style id="custom-css-style"> 注入，位于最后，
 *   同优先级下可覆盖预设与文件主题；用户可引用任意 CSS 变量
 * - 变更即时生效
 *
 * @author chiangyang
 */
import {
  getThemePreset,
  setThemePreset,
  getCustomCss,
  setCustomCss,
  getThemeFile,
  setThemeFile,
} from './store'
import { applyTheme } from './theme'
import { native } from './native'

/** 设置面板 radio 值中文件主题项的前缀（后接裸文件名，如 'file:晚霞.css'） */
export const FILE_THEME_PREFIX = 'file:'

export interface ThemePreset {
  id: string
  /** i18n 键（settings.presetXxx） */
  nameKey: string
  /** 注入的 CSS 变量覆盖；default 为空串（使用 style.css 内建配色） */
  css: string
}

/** 深浅两套变量覆盖的模板 */
function presetCss(
  light: Record<string, string>,
  dark: Record<string, string>,
  id: string,
): string {
  const vars = (set: Record<string, string>) =>
    Object.entries(set)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n')
  return `html[data-theme-preset='${id}']:not(.dark) {\n  color-scheme: light;\n${vars(light)}\n}\n\nhtml[data-theme-preset='${id}'].dark {\n  color-scheme: dark;\n${vars(dark)}\n}`
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'default', nameKey: 'settings.presetDefault', css: '' },
  {
    // 主界面的深色主题：本体就是 html.dark 内建变量，无需注入 CSS；
    // 选择它 = 切换到深色模式
    id: 'dark',
    nameKey: 'settings.presetDark',
    css: '',
  },
  {
    id: 'sepia',
    nameKey: 'settings.presetSepia',
    css: presetCss(
      {
        '--bg': '#f7f1e3',
        '--fg': '#433422',
        '--muted': '#8a7a5c',
        '--border': '#e0d5b8',
        '--accent': '#b07d2b',
        '--code-bg': '#efe6cf',
        '--pre-bg': '#f0e8d0',
        '--quote-bg': '#f2ead6',
        '--toolbar-bg': 'rgba(247, 241, 227, 0.85)',
        '--error-fg': '#c0392b',
        '--error-bg': '#fbeee8',
      },
      {
        '--bg': '#2b2620',
        '--fg': '#d8cfc0',
        '--muted': '#948a78',
        '--border': '#453d30',
        '--accent': '#d4a24e',
        '--code-bg': '#353026',
        '--pre-bg': '#302a22',
        '--quote-bg': '#353026',
        '--toolbar-bg': 'rgba(43, 38, 32, 0.85)',
        '--error-fg': '#f97583',
        '--error-bg': '#3a2a26',
      },
      'sepia',
    ),
  },
  {
    id: 'green',
    nameKey: 'settings.presetGreen',
    css: presetCss(
      {
        '--bg': '#cce8cf',
        '--fg': '#1f3323',
        '--muted': '#5f7a64',
        '--border': '#a8cbb0',
        '--accent': '#2e7d32',
        '--code-bg': '#b8dcc0',
        '--pre-bg': '#bde0c4',
        '--quote-bg': '#bfe0c5',
        '--toolbar-bg': 'rgba(204, 232, 207, 0.85)',
        '--error-fg': '#c0392b',
        '--error-bg': '#f3e3e0',
      },
      {
        '--bg': '#1d2a20',
        '--fg': '#cfe3d2',
        '--muted': '#86a18c',
        '--border': '#2f4034',
        '--accent': '#6fbf7f',
        '--code-bg': '#243328',
        '--pre-bg': '#203024',
        '--quote-bg': '#243328',
        '--toolbar-bg': 'rgba(29, 42, 32, 0.85)',
        '--error-fg': '#f97583',
        '--error-bg': '#33272a',
      },
      'green',
    ),
  },
]

/** 应用主题预设：写入 html[data-theme-preset] 并注入对应变量覆盖 */
export function applyThemePreset(id: string): void {
  const preset = THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0]
  if (preset.id === 'default') {
    delete document.documentElement.dataset.themePreset
  } else {
    document.documentElement.dataset.themePreset = preset.id
  }
  let style = document.getElementById('theme-preset-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'theme-preset-style'
    document.head.appendChild(style)
  }
  style.textContent = preset.css
}

/** 读取当前主题预设 id */
export function currentThemePreset(): string {
  return getThemePreset()
}

/** 应用自定义 CSS（空串即清除注入） */
export function applyCustomCss(css: string): void {
  let style = document.getElementById('custom-css-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'custom-css-style'
    document.head.appendChild(style)
  }
  style.textContent = css
}

/** 启动时恢复：预设 + 自定义 CSS */
export function restoreThemeStyles(): void {
  applyThemePreset(getThemePreset())
  applyCustomCss(getCustomCss())
}

/** 保存主题预设（持久化 + 即时应用）。
 *
 * 深色预设 = 切换到主界面深色模式（预设回落为 default）；
 * 其余预设按各自的浅色外观应用（当前若为深色会切回浅色）。
 * 选择任意内置预设都会退出文件式主题（两者互斥）。
 */
export function changeThemePreset(id: string): void {
  const isDarkPreset = id === 'dark'
  setThemeFile('')
  clearFileTheme()
  setThemePreset(isDarkPreset ? 'default' : id)
  applyThemePreset(isDarkPreset ? 'default' : id)
  void applyTheme(isDarkPreset)
}

/** 保存自定义 CSS（持久化 + 即时应用） */
export function changeCustomCss(css: string): void {
  setCustomCss(css)
  applyCustomCss(css)
}

// ---------------------------------------------------------------------------
// 文件式主题（~/.tmd/themes/*.css）
// ---------------------------------------------------------------------------

/** 应用文件式主题：把 CSS 文本注入 preset 与 custom 之间的 <style> 层 */
export function applyFileTheme(css: string): void {
  let style = document.getElementById('theme-file-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'theme-file-style'
    // 必须位于自定义 CSS 之前：保证 custom-css 始终拥有最高优先级
    const custom = document.getElementById('custom-css-style')
    if (custom) custom.before(style)
    else document.head.appendChild(style)
  }
  style.textContent = css
}

/** 移除文件式主题注入层 */
export function clearFileTheme(): void {
  document.getElementById('theme-file-style')?.remove()
}

/**
 * 保存并应用文件式主题（持久化文件名 + 即时注入）。
 * 文件主题与内置预设互斥：预设层回落 default（移除 data-theme-preset），
 * 但不联动深浅模式——文件 CSS 作者自行用 html.dark 适配深色。
 */
export function changeFileTheme(fileName: string, css: string): void {
  setThemeFile(fileName)
  setThemePreset('default')
  applyThemePreset('default')
  applyFileTheme(css)
}

/**
 * 启动时异步恢复文件式主题。
 * 文件缺失 / 读取失败（用户在应用外删除了 CSS）时清除持久化并回调通知，
 * 界面自然回落内置变量；浏览器环境（无 native）无文件主题可恢复。
 * @param onMissing - 文件缺失回调（通常弹 toast），参数为丢失的文件名
 * @returns 是否恢复成功（无文件主题也算成功）
 */
export async function restoreFileTheme(onMissing: (fileName: string) => void): Promise<boolean> {
  const fileName = getThemeFile()
  if (!fileName || !native) return true
  const css = await native.readTheme(fileName)
  if (css == null) {
    setThemeFile('')
    onMissing(fileName)
    return false
  }
  // 与 changeFileTheme 同不变量：文件主题激活时预设层恒为 default
  setThemePreset('default')
  applyThemePreset('default')
  applyFileTheme(css)
  return true
}

/**
 * 计算设置面板主题列表应高亮的 radio 值（纯函数，单测覆盖）。
 * - 文件主题激活时高亮对应文件项（`file:` 前缀）
 * - 内置体系：default + 深色 → dark 项；其余 → 各自预设项
 */
export function resolveThemeSelection(isDark: boolean, preset: string, fileName: string): string {
  if (fileName) return FILE_THEME_PREFIX + fileName
  if (isDark && preset === 'default') return 'dark'
  return preset
}

/** radio 值是否为文件主题项；是则返回裸文件名，否则 null（内置项） */
export function parseThemeRadioValue(value: string): string | null {
  return value.startsWith(FILE_THEME_PREFIX) ? value.slice(FILE_THEME_PREFIX.length) : null
}

/** 文件主题显示名：去掉 .css 扩展名（与主进程 themeDisplayName 同一规则） */
export function displayThemeName(fileName: string): string {
  return fileName.replace(/\.css$/i, '')
}
