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

/**
 * 液态玻璃（Liquid Glass）预设的完整样式表。
 *
 * 视觉近似路线（运行于 Electron/Chromium，无需 SVG 折射等重型管线）：
 * 半透明表面 + backdrop-filter 强模糊与高饱和 + 1px 亮边缘 + 顶部内高光
 * + 柔和投影；窗口底层铺淡彩光晕壁纸（--glass-wallpaper），玻璃折射出的
 * 彩色即「液态感」来源。浅色/深色各自一套变量，组件规则两态共用。
 *
 * 玻璃化覆盖：窗口壁纸、工具栏/查找栏、侧边栏、标签栏、编辑纸张（悬浮
 * 玻璃卡片）、源码编辑器、全部浮层与菜单。系统开启「降低透明度」时
 * （prefers-reduced-transparency）自动回落近实色表面并撤模糊；
 * 打印 / 导出 PDF 撤掉壁纸与玻璃，纸张回归实色（见末尾 @media print）。
 */
const GLASS_PRESET_CSS = `
html[data-theme-preset='glass']:not(.dark) {
  color-scheme: light;
  /* 窗口壁纸：四团低饱和彩光（蓝/紫/粉/青）+ 近白底色；body 固定不滚动，壁纸天然固定 */
  --glass-wallpaper:
    radial-gradient(42rem 34rem at 8% -10%, rgba(96, 155, 255, 0.50), transparent 62%),
    radial-gradient(40rem 32rem at 96% 2%, rgba(180, 130, 255, 0.42), transparent 60%),
    radial-gradient(46rem 38rem at 84% 102%, rgba(255, 150, 196, 0.38), transparent 60%),
    radial-gradient(44rem 36rem at -4% 100%, rgba(96, 206, 214, 0.40), transparent 62%),
    linear-gradient(180deg, #f5f7fc 0%, #edeff7 100%);
  --glass-panel: rgba(255, 255, 255, 0.64);
  --glass-paper: rgba(252, 253, 255, 0.56);
  --glass-bar: rgba(255, 255, 255, 0.50);
  --glass-edge: rgba(255, 255, 255, 0.70);
  --glass-highlight: inset 0 1px 1px rgba(255, 255, 255, 0.80);
  --glass-shadow: 0 18px 48px rgba(33, 48, 77, 0.16), 0 2px 12px rgba(33, 48, 77, 0.08);
  --glass-blur: blur(28px) saturate(180%);
  /* 常规令牌：半透明表面让嵌套控件仍带玻璃叠加感 */
  --bg: rgba(255, 255, 255, 0.64);
  --fg: #1d2433;
  --muted: #5d6778;
  --border: rgba(25, 42, 70, 0.14);
  --accent: #3f7cf0;
  --bg-hover: rgba(255, 255, 255, 0.52);
  --code-bg: rgba(255, 255, 255, 0.56);
  --pre-bg: rgba(246, 248, 253, 0.62);
  --quote-bg: rgba(255, 255, 255, 0.42);
  --toolbar-bg: rgba(255, 255, 255, 0.50);
  --error-fg: #d1242f;
  --error-bg: rgba(255, 241, 240, 0.72);
}

html[data-theme-preset='glass'].dark {
  color-scheme: dark;
  /* 基底均值贴近窗口合成底色 #1e2127，避免窗口 resize 瞬间露出底色边 */
  --glass-wallpaper:
    radial-gradient(42rem 34rem at 6% -10%, rgba(58, 104, 220, 0.46), transparent 62%),
    radial-gradient(40rem 32rem at 98% 0%, rgba(128, 72, 214, 0.44), transparent 60%),
    radial-gradient(46rem 38rem at 86% 104%, rgba(186, 62, 128, 0.30), transparent 60%),
    radial-gradient(44rem 36rem at -6% 102%, rgba(30, 150, 162, 0.34), transparent 62%),
    linear-gradient(180deg, #22252d 0%, #1b1e25 100%);
  --glass-panel: rgba(38, 41, 49, 0.62);
  --glass-paper: rgba(31, 34, 41, 0.54);
  --glass-bar: rgba(28, 30, 37, 0.52);
  --glass-edge: rgba(255, 255, 255, 0.14);
  --glass-highlight: inset 0 1px 1px rgba(255, 255, 255, 0.20);
  --glass-shadow: 0 18px 48px rgba(0, 0, 0, 0.52), 0 2px 12px rgba(0, 0, 0, 0.30);
  --glass-blur: blur(28px) saturate(160%);
  --bg: rgba(38, 41, 49, 0.62);
  --fg: #dde1e9;
  --muted: #929aa7;
  --border: rgba(255, 255, 255, 0.12);
  --accent: #7aa2e8;
  --bg-hover: rgba(255, 255, 255, 0.08);
  --code-bg: rgba(255, 255, 255, 0.10);
  --pre-bg: rgba(255, 255, 255, 0.07);
  --quote-bg: rgba(255, 255, 255, 0.05);
  --toolbar-bg: rgba(28, 30, 37, 0.52);
  --error-fg: #f97583;
  --error-bg: rgba(58, 36, 38, 0.72);
}

/* ---- 窗口壁纸：body 不滚动（overflow:hidden，滚动在内层容器），壁纸不随内容移动 ---- */
html[data-theme-preset='glass'] body {
  background-image: var(--glass-wallpaper);
  background-repeat: no-repeat;
  background-size: cover;
}

/* ---- 玻璃条：工具栏 / 查找栏（链接栏同 .find-bar） ---- */
html[data-theme-preset='glass'] .toolbar,
html[data-theme-preset='glass'] .find-bar,
html[data-theme-preset='glass'] .tab-bar {
  background-color: var(--glass-bar);
  backdrop-filter: var(--glass-blur);
  border-bottom-color: var(--glass-edge);
  box-shadow: var(--glass-highlight);
}

/* ---- 侧边栏：整块玻璃立板 ---- */
html[data-theme-preset='glass'] .sidebar {
  background-color: var(--glass-bar);
  backdrop-filter: var(--glass-blur);
  border-right-color: var(--glass-edge);
}

/* ---- 活动标签：玻璃条上的凸起玻璃片 ---- */
html[data-theme-preset='glass'] .tab.active {
  background-color: var(--glass-panel);
  border-color: var(--glass-edge);
  box-shadow: var(--glass-highlight);
}

/* ---- 编辑纸张：悬浮玻璃卡片，四围露出壁纸（宽度仍跟随排版设置） ---- */
html[data-theme-preset='glass'] .page {
  max-width: min(var(--editor-page-width, 860px), calc(100% - 48px));
  margin: 24px auto 56px;
  border: 1px solid var(--glass-edge);
  border-radius: 18px;
  background-color: var(--glass-paper);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), var(--glass-highlight);
}

/* ---- 源码模式：CodeMirror 自身即玻璃纸（与 .page 同规格） ---- */
html[data-theme-preset='glass'] #src-editor .cm-editor {
  border: 1px solid var(--glass-edge);
  border-radius: 18px;
  background-color: var(--glass-paper);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow), var(--glass-highlight);
  /* 裁掉滚动内容与行号栏的尖角（本项目未启用 CM 浮层补全，无 tooltip 被裁风险） */
  overflow: hidden;
}

html[data-theme-preset='glass'] #src-editor .cm-gutters {
  background-color: transparent;
  border-right-color: var(--glass-edge);
}

/* ---- 浮层玻璃：快速切换 / 全文搜索 / 历史版本 / 设置 / 菜单（含右键） / 表格工具栏 ---- */
html[data-theme-preset='glass'] .qs-panel,
html[data-theme-preset='glass'] .search-panel,
html[data-theme-preset='glass'] .settings-modal,
html[data-theme-preset='glass'] .more-menu,
html[data-theme-preset='glass'] .table-toolbar {
  background-color: var(--glass-panel);
  backdrop-filter: var(--glass-blur);
  border-color: var(--glass-edge);
  box-shadow: var(--glass-shadow), var(--glass-highlight);
}

html[data-theme-preset='glass'] .qs-panel,
html[data-theme-preset='glass'] .search-panel,
html[data-theme-preset='glass'] .settings-modal {
  border-radius: 16px;
}

html[data-theme-preset='glass'] .more-menu,
html[data-theme-preset='glass'] .table-toolbar {
  border-radius: 12px;
}

/* ---- 设置面板左侧导航：与 modal 形成层次（用更透明的玻璃条，
      而非 --bg-hover 叠加在 modal 上视觉一片白） ---- */
html[data-theme-preset='glass'] .settings-nav {
  background-color: var(--glass-bar);
  border-right-color: var(--glass-edge);
}

/* ---- 打印 / 导出 PDF：撤掉壁纸与玻璃，PDF 不带彩色底，纸张跟随深浅回归实色 ---- */
@media print {
  html[data-theme-preset='glass'] body {
    background: #ffffff;
  }
  html[data-theme-preset='glass'].dark body {
    background: #1e2127;
  }
  html[data-theme-preset='glass'] .page,
  html[data-theme-preset='glass'] #src-editor .cm-editor {
    margin: 0;
    border: none;
    border-radius: 0;
    background: #ffffff;
    box-shadow: none;
    backdrop-filter: none;
  }
  html[data-theme-preset='glass'].dark .page,
  html[data-theme-preset='glass'].dark #src-editor .cm-editor {
    background: #1e2127;
  }
}

/* ---- 系统「降低透明度」：壁纸去彩光、表面近实色并撤模糊（兼作低性能兜底） ---- */
@media (prefers-reduced-transparency: reduce) {
  html[data-theme-preset='glass']:not(.dark) {
    --glass-wallpaper: linear-gradient(180deg, #f5f7fc 0%, #edeff7 100%);
    --glass-panel: rgba(255, 255, 255, 0.94);
    --glass-paper: rgba(255, 255, 255, 0.96);
    --glass-bar: rgba(248, 249, 252, 0.94);
    --glass-blur: none;
  }
  html[data-theme-preset='glass'].dark {
    --glass-wallpaper: linear-gradient(180deg, #22252d 0%, #1b1e25 100%);
    --glass-panel: rgba(38, 41, 49, 0.94);
    --glass-paper: rgba(31, 34, 41, 0.96);
    --glass-bar: rgba(28, 30, 37, 0.94);
    --glass-blur: none;
  }
}
`

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
        '--bg-hover': '#e8dec5',
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
        '--bg-hover': '#353026',
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
        '--bg-hover': '#aed3b6',
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
        '--bg-hover': '#243328',
      },
      'green',
    ),
  },
  {
    // 液态玻璃：除变量外还包含组件级覆盖（壁纸/玻璃表面/浮层/打印兜底），
    // 见 GLASS_PRESET_CSS；浅深两套均支持，工具栏按钮可随时切换深浅
    id: 'glass',
    nameKey: 'settings.presetGlass',
    css: GLASS_PRESET_CSS,
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
