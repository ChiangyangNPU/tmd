/**
 * 离线 HTML 导出的本地资源加载（纯 Node，主进程懒加载并缓存）。
 *
 * dist/export-assets 由 scripts/copy-export-assets.mjs 在 build 后生成：
 * - mermaid.min.js / katex.min.js / auto-render.min.js / katex.min.css
 * - KaTeX woff2 字体（导出时内联成 data URI，保证单文件离线可渲染）
 *
 * 资源缺失（开发环境未 build / 打包裁剪异常）时返回 null，渲染层回退 CDN。
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')

const ASSET_DIR = path.join(__dirname, '..', 'dist', 'export-assets')

/** @type {Promise<{ mermaidJs: string, katexJs: string, katexAutoRenderJs: string, katexCss: string } | null> | null} */
let cached = null

/** 内联 JS 放进 <script> 前转义闭合标签，避免提前截断脚本 */
/** @param {string} js */
function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script')
}

/** 内联 CSS 放进 <style> 前转义闭合标签（KaTeX CSS 通常不含，防御性处理） */
/** @param {string} css */
function escapeStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style')
}

/**
 * 把 KaTeX CSS 的 woff/ttf 回退去掉，woff2 全部转 data URI。
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function inlineKatexCss(dir) {
  let css = await fs.readFile(path.join(dir, 'katex.min.css'), 'utf-8')
  css = css.replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, '')
  css = css.replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '')
  const names = [...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1])
  for (const name of [...new Set(names)]) {
    const data = await fs.readFile(path.join(dir, 'fonts', name))
    css = css.replaceAll(
      `url(fonts/${name})`,
      `url(data:font/woff2;base64,${data.toString('base64')})`,
    )
  }
  return escapeStyle(css)
}

/** 加载并缓存导出资源；缺失时返回 null */
async function loadExportAssets() {
  cached ??= (async () => {
    try {
      const [mermaidJs, katexJs, katexAutoRenderJs, katexCss] = await Promise.all([
        fs.readFile(path.join(ASSET_DIR, 'mermaid.min.js'), 'utf-8'),
        fs.readFile(path.join(ASSET_DIR, 'katex.min.js'), 'utf-8'),
        fs.readFile(path.join(ASSET_DIR, 'auto-render.min.js'), 'utf-8'),
        inlineKatexCss(ASSET_DIR),
      ])
      return {
        mermaidJs: escapeScript(mermaidJs),
        katexJs: escapeScript(katexJs),
        katexAutoRenderJs: escapeScript(katexAutoRenderJs),
        katexCss,
      }
    } catch {
      return null
    }
  })()
  return cached
}

module.exports = { loadExportAssets }
