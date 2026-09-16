/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  // Electron 生产模式用 file:// 加载，必须用相对路径引用资源
  base: './',
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
