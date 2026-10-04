/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
// 预设 CSS 的单一来源：渲染层运行时注入与构建期首帧静态注入共用，
// 保证两层内容永远一致（该模块零依赖、Node 侧可安全加载）
import { BUILTIN_PRESET_CSS, LIQUID_LENS_SVG } from './src/theme-preset-css'

/**
 * 主题首帧防闪（FOUC）：把全部内置预设 CSS 与液态玻璃 Pro 的 SVG 滤镜
 * 定义静态注入 index.html——public/boot.js 在首帧前从 localStorage 恢复
 * data-theme-preset 属性后，选中的预设从第一帧就是正确外观，不再先闪
 * 默认浅色再切换。规则全部以 html[data-theme-preset=…] 门控，属性不挂
 * 时整体失活，因此该 <style> 常驻无副作用。
 * 离屏导出页（export-renderer.html）永不用预设主题，跳过注入。
 */
function themeFirstPaint(): Plugin {
  const css = Object.values(BUILTIN_PRESET_CSS).join('\n')
  return {
    name: 'tmd-theme-first-paint',
    transformIndexHtml(html, ctx) {
      const path = ctx.filename ?? ctx.path ?? ''
      if (path.includes('export-renderer')) return html
      return html
        .replace('</head>', `    <style id="theme-preset-static">\n${css}\n    </style>\n  </head>`)
        .replace('<body>', `<body>\n    ${LIQUID_LENS_SVG}`)
    },
  }
}

export default defineConfig({
  // Electron 生产模式用 file:// 加载，必须用相对路径引用资源
  base: './',
  plugins: [themeFirstPaint()],
  build: {
    rollupOptions: {
      // 多入口：
      // - index.html：主窗口
      // - export-renderer.html：Word / 长图的离屏导出页（隐藏窗口加载，离线渲染 Mermaid/KaTeX）
      input: {
        index: 'index.html',
        'export-renderer': 'export-renderer.html',
      },
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
  },
})
