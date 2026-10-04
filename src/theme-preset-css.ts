/**
 * 内置主题预设的纯 CSS 资源（零依赖、无 DOM 副作用，Node 与渲染层两端可用）
 *
 * 为什么独立成模块：预设 CSS 有两个消费者，必须单一来源——
 * - 渲染层 theme-presets.ts：运行时把当前预设注入 <style id="theme-preset-style">
 * - 构建期 vite.config.ts：把全部预设 CSS 静态注入 index.html（首帧防闪，
 *   配合 public/boot.js 在首帧前恢复 data-theme-preset 属性）
 *
 * 本文件禁止 import 任何会触碰 DOM/window/localStorage 的模块；
 * vite.config.ts 在 Node 侧加载它，任何浏览器 API 都会炸掉构建。
 *
 * @author chiangyang
 */

/** 深浅两套变量覆盖的模板 */
export function presetCss(
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

export const SEPIA_CSS = presetCss(
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
)

export const GREEN_CSS = presetCss(
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
)

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
export const GLASS_CSS = `
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
html[data-theme-preset='glass'] .history-panel,
html[data-theme-preset='glass'] .context-menu,
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

/**
 * 「液态玻璃 Pro」折射位移图（feDisplacementMap 采样坐标编码图，PNG data URI）。
 *
 * R/G 通道编码背景采样点的 x/y 偏移（128 = 不动）：元素边缘的通道值偏离
 * 128，把背景内容向边缘外"吸进来"压缩，形成苹果 Liquid Glass 的凸透镜
 * 边缘（lensing）；中心 128 保持不折射。由 scripts/gen-lens-map.mjs 生成
 * （逐像素：距边距离的平方缓动 × 方向），改参数后重跑脚本替换此串即可。
 */
export const LENS_MAP_DATA_URI =
  'data:image/png;base64,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'

/**
 * 液态玻璃 Pro 的 SVG 滤镜定义（feImage 位移图 + feDisplacementMap 透镜）。
 *
 * 由 vite.config.ts 静态注入 index.html <body> 开头——CSS 里的
 * url(#tmd-lens) 按文档内 id 引用，SVG 必须常驻 DOM。width/height 为 0
 * 不占布局；不能用 display:none（会让部分浏览器的滤镜失效）。
 * scale=40：边缘最大位移 = scale/2 = 20px（经 3px 模糊柔化后呈透镜感）。
 */
export const LIQUID_LENS_SVG = `<svg width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute">
  <filter id="tmd-lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feImage href="${LENS_MAP_DATA_URI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="40" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</svg>`

/**
 * 液态玻璃 Pro 预设：在液态玻璃（半透明 + 高饱和 + 亮边高光）之上引入
 * 真实折射——SVG feDisplacementMap 透镜让浮层边缘的背景内容弯曲压缩，
 * 接近苹果 Liquid Glass 的 material 手感。分层策略：
 * - 小/中表面（工具栏、侧边栏、标签、全部浮层）：折射透镜 + 轻模糊
 *   （blur 3px 保留背景细节，位移才有东西可弯）
 * - 大表面（编辑纸张 / 源码编辑器）：禁用位移——feImage 随元素拉伸，
 *   超大元素上折射带占比失真，只做模糊 + 高饱和 + 高光
 * 降级与液态玻璃一致：prefers-reduced-transparency 近实色撤滤镜、
 * 打印 / 导出 PDF 回归实色。
 */
export const LIQUID_CSS = `
html[data-theme-preset='liquid']:not(.dark) {
  color-scheme: light;
  /* 壁纸与液态玻璃同源：四团低饱和彩光 + 近白底色，为边缘折射提供连续背景 */
  --lq-wallpaper:
    radial-gradient(42rem 34rem at 8% -10%, rgba(96, 155, 255, 0.50), transparent 62%),
    radial-gradient(40rem 32rem at 96% 2%, rgba(180, 130, 255, 0.42), transparent 60%),
    radial-gradient(46rem 38rem at 84% 102%, rgba(255, 150, 196, 0.38), transparent 60%),
    radial-gradient(44rem 36rem at -4% 100%, rgba(96, 206, 214, 0.40), transparent 62%),
    linear-gradient(180deg, #f5f7fc 0%, #edeff7 100%);
  --lq-bar: rgba(255, 255, 255, 0.38);
  --lq-surface: rgba(255, 255, 255, 0.36);
  --lq-paper: rgba(255, 255, 255, 0.44);
  --lq-edge: rgba(255, 255, 255, 0.62);
  --lq-specular:
    inset 0 1.5px 1px -0.5px rgba(255, 255, 255, 0.92),
    inset 0 -1px 1px -0.5px rgba(255, 255, 255, 0.40),
    inset 1.5px 0 1px -0.5px rgba(255, 255, 255, 0.40),
    inset -1.5px 0 1px -0.5px rgba(255, 255, 255, 0.40);
  --lq-shadow: 0 10px 34px rgba(33, 48, 77, 0.16), 0 2px 10px rgba(33, 48, 77, 0.08);
  /* 折射链：SVG 透镜在前（先弯后糊），轻模糊保留中心可读 */
  --lq-glass: url(#tmd-lens) blur(3px) saturate(175%) brightness(1.05);
  --lq-paper-glass: blur(20px) saturate(175%) brightness(1.04);
  /* 常规令牌与液态玻璃一致：半透明表面让嵌套控件仍带玻璃叠加感 */
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

html[data-theme-preset='liquid'].dark {
  color-scheme: dark;
  /* 基底均值贴近窗口合成底色 #1e2127，避免窗口 resize 瞬间露出底色边 */
  --lq-wallpaper:
    radial-gradient(42rem 34rem at 6% -10%, rgba(58, 104, 220, 0.46), transparent 62%),
    radial-gradient(40rem 32rem at 98% 0%, rgba(128, 72, 214, 0.44), transparent 60%),
    radial-gradient(46rem 38rem at 86% 104%, rgba(186, 62, 128, 0.30), transparent 60%),
    radial-gradient(44rem 36rem at -6% 102%, rgba(30, 150, 162, 0.34), transparent 62%),
    linear-gradient(180deg, #22252d 0%, #1b1e25 100%);
  --lq-bar: rgba(38, 41, 49, 0.40);
  --lq-surface: rgba(38, 41, 49, 0.40);
  --lq-paper: rgba(31, 34, 41, 0.50);
  --lq-edge: rgba(255, 255, 255, 0.14);
  --lq-specular:
    inset 0 1.5px 1px -0.5px rgba(255, 255, 255, 0.30),
    inset 0 -1px 1px -0.5px rgba(255, 255, 255, 0.12),
    inset 1.5px 0 1px -0.5px rgba(255, 255, 255, 0.12),
    inset -1.5px 0 1px -0.5px rgba(255, 255, 255, 0.12);
  --lq-shadow: 0 12px 36px rgba(0, 0, 0, 0.50), 0 2px 10px rgba(0, 0, 0, 0.30);
  --lq-glass: url(#tmd-lens) blur(3px) saturate(165%) brightness(1.08);
  --lq-paper-glass: blur(20px) saturate(160%) brightness(1.08);
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

/* ---- 窗口壁纸：body 不滚动（滚动在内层容器），壁纸不随内容移动 ---- */
html[data-theme-preset='liquid'] body {
  background-image: var(--lq-wallpaper);
  background-repeat: no-repeat;
  background-size: cover;
}

/* ---- 折射玻璃条：工具栏 / 查找栏 / 标签栏 / 侧边栏 ---- */
html[data-theme-preset='liquid'] .toolbar,
html[data-theme-preset='liquid'] .find-bar,
html[data-theme-preset='liquid'] .tab-bar,
html[data-theme-preset='liquid'] .sidebar {
  background-color: var(--lq-bar);
  backdrop-filter: var(--lq-glass);
  border-color: var(--lq-edge);
  box-shadow: var(--lq-specular);
}

/* ---- 活动标签：玻璃条上的凸起玻璃片 ---- */
html[data-theme-preset='liquid'] .tab.active {
  background-color: var(--lq-surface);
  border-color: var(--lq-edge);
  box-shadow: var(--lq-specular);
}

/* ---- 编辑纸张：悬浮玻璃卡片。大表面禁用位移（比例失真），只做模糊 + 高饱和 ---- */
html[data-theme-preset='liquid'] .page {
  max-width: min(var(--editor-page-width, 860px), calc(100% - 48px));
  margin: 24px auto 56px;
  border: 1px solid var(--lq-edge);
  border-radius: 18px;
  background-color: var(--lq-paper);
  backdrop-filter: var(--lq-paper-glass);
  box-shadow: var(--lq-shadow), var(--lq-specular);
}

/* ---- 源码模式：CodeMirror 与 .page 同规格 ---- */
html[data-theme-preset='liquid'] #src-editor .cm-editor {
  border: 1px solid var(--lq-edge);
  border-radius: 18px;
  background-color: var(--lq-paper);
  backdrop-filter: var(--lq-paper-glass);
  box-shadow: var(--lq-shadow), var(--lq-specular);
  /* 裁掉滚动内容与行号栏的尖角 */
  overflow: hidden;
}

html[data-theme-preset='liquid'] #src-editor .cm-gutters {
  background-color: transparent;
  border-right-color: var(--lq-edge);
}

/* ---- 浮层（折射）：快速切换 / 全文搜索 / 历史版本 / 设置 / 菜单（含右键） / 表格工具栏 ---- */
html[data-theme-preset='liquid'] .qs-panel,
html[data-theme-preset='liquid'] .search-panel,
html[data-theme-preset='liquid'] .settings-modal,
html[data-theme-preset='liquid'] .history-panel,
html[data-theme-preset='liquid'] .context-menu,
html[data-theme-preset='liquid'] .more-menu,
html[data-theme-preset='liquid'] .table-toolbar {
  background-color: var(--lq-surface);
  backdrop-filter: var(--lq-glass);
  border-color: var(--lq-edge);
  box-shadow: var(--lq-shadow), var(--lq-specular);
}

html[data-theme-preset='liquid'] .qs-panel,
html[data-theme-preset='liquid'] .search-panel,
html[data-theme-preset='liquid'] .settings-modal {
  border-radius: 16px;
}

html[data-theme-preset='liquid'] .more-menu,
html[data-theme-preset='liquid'] .table-toolbar,
html[data-theme-preset='liquid'] .context-menu {
  border-radius: 12px;
}

/* ---- 设置面板左侧导航：更透明的玻璃条，与 modal 形成层次 ---- */
html[data-theme-preset='liquid'] .settings-nav {
  background-color: var(--lq-bar);
  border-right-color: var(--lq-edge);
}

/* ---- 打印 / 导出 PDF：撤掉壁纸与玻璃，PDF 不带彩色底，纸张跟随深浅回归实色 ---- */
@media print {
  html[data-theme-preset='liquid'] body {
    background: #ffffff;
  }
  html[data-theme-preset='liquid'].dark body {
    background: #1e2127;
  }
  html[data-theme-preset='liquid'] .page,
  html[data-theme-preset='liquid'] #src-editor .cm-editor {
    margin: 0;
    border: none;
    border-radius: 0;
    background: #ffffff;
    box-shadow: none;
    backdrop-filter: none;
  }
  html[data-theme-preset='liquid'].dark .page,
  html[data-theme-preset='liquid'].dark #src-editor .cm-editor {
    background: #1e2127;
  }
}

/* ---- 系统「降低透明度」：壁纸去彩光、表面近实色并撤滤镜（兼作低性能兜底） ---- */
@media (prefers-reduced-transparency: reduce) {
  html[data-theme-preset='liquid']:not(.dark) {
    --lq-wallpaper: linear-gradient(180deg, #f5f7fc 0%, #edeff7 100%);
    --lq-bar: rgba(248, 249, 252, 0.94);
    --lq-surface: rgba(255, 255, 255, 0.94);
    --lq-paper: rgba(255, 255, 255, 0.96);
    --lq-glass: none;
    --lq-paper-glass: none;
  }
  html[data-theme-preset='liquid'].dark {
    --lq-wallpaper: linear-gradient(180deg, #22252d 0%, #1b1e25 100%);
    --lq-bar: rgba(28, 30, 37, 0.94);
    --lq-surface: rgba(38, 41, 49, 0.94);
    --lq-paper: rgba(31, 34, 41, 0.96);
    --lq-glass: none;
    --lq-paper-glass: none;
  }
}
`

/** 全部非空预设 CSS（首帧静态注入用；default/dark 预设为空串无需注入） */
export const BUILTIN_PRESET_CSS: Record<string, string> = {
  sepia: SEPIA_CSS,
  green: GREEN_CSS,
  glass: GLASS_CSS,
  liquid: LIQUID_CSS,
}
