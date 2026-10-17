/**
 * 离线 HTML 导出的本地资源拷贝：把 Mermaid / KaTeX 运行时与字体放到
 * dist/export-assets，供主进程在导出时内联（打包产物包含 dist，因此无需
 * 运行时访问 node_modules）。
 *
 * @author chiangyang
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(REPO, 'dist', 'export-assets')
const NODE_MODULES = path.join(REPO, 'node_modules')

const FILES = [
  ['mermaid/dist/mermaid.min.js', 'mermaid.min.js'],
  ['katex/dist/katex.min.js', 'katex.min.js'],
  ['katex/dist/contrib/auto-render.min.js', 'auto-render.min.js'],
  ['katex/dist/katex.min.css', 'katex.min.css'],
]

await rm(OUT, { recursive: true, force: true })
await mkdir(path.join(OUT, 'fonts'), { recursive: true })
for (const [from, to] of FILES) {
  await cp(path.join(NODE_MODULES, from), path.join(OUT, to))
}
// 只带 woff2：现代浏览器 / ePub 阅读器均支持；woff/ttf 回退在 CSS 里移除
const fonts = (await readdir(path.join(NODE_MODULES, 'katex/dist/fonts'))).filter((name) =>
  name.endsWith('.woff2'),
)
for (const name of fonts) {
  await cp(path.join(NODE_MODULES, 'katex/dist/fonts', name), path.join(OUT, 'fonts', name))
}
console.log(
  `[export-assets] ${FILES.length} files + ${fonts.length} woff2 fonts -> dist/export-assets`,
)
