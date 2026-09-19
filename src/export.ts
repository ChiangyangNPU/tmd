/**
 * 主窗口侧导出动作：
 * - HTML：独立文件（Mermaid/KaTeX 走 CDN，样式内联）
 * - PDF：系统打印对话框
 * - Word / 长图：把共享文档核心（export-doc.ts）组装为任务，
 *   交给离屏导出服务（electron/exporter.cjs 的隐藏窗口）完成渲染与转换
 *
 * Markdown 渲染规则与导出样式只有一份（export-doc.ts），本层只负责
 * "从当前窗口采集状态 + 组织外壳 + 反馈结果"。
 *
 * @author chiangyang
 */
import { native } from './native'
import { getLocale, t } from './i18n'
import { showToast } from './files'
import {
  EXPORT_CSS,
  buildExportDocument,
  buildThemeVarsBlock,
  collectThemeVars,
  renderMarkdown,
} from './export-doc'
import { renderLatexDocument } from './export-latex'
import type { ExportTask } from './export-bridge'

// 向后兼容：既有模块/测试从 './export' 引用这些核心符号，统一由核心模块再导出
export {
  buildThemeVarsBlock,
  collectThemeVars,
  convertImgTokens,
  renderMarkdown,
  stripFrontMatter,
} from './export-doc'

/**
 * 组装导出页 HTML（纯函数，便于单测）：
 * - vars：collectThemeVars 的主题变量快照，经 buildThemeVarsBlock 注入 :root
 * - isDark：mermaid 图表切 dark 主题（与当前深浅模式一致）
 */
export function buildExportHtml(
  markdown: string,
  currentName: string,
  vars: Record<string, string>,
  isDark: boolean,
): string {
  const mermaidTheme = isDark ? 'dark' : 'default'
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="UTF-8">
<title>${currentName.replace(/\.md$/i, '')}</title>
<style>${buildThemeVarsBlock(vars)}</style>
<style>${EXPORT_CSS}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: '${mermaidTheme}' });</script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body, { delimiters: [{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}] });"></script>
</head>
<body>
${renderMarkdown(markdown)}
</body>
</html>`
}

/** 导出 HTML：按当前主题渲染为内嵌样式、引 Mermaid/KaTeX CDN 的独立页面（Electron 存盘 / 浏览器下载） */
export async function exportHtml(markdown: string, currentName: string) {
  const html = buildExportHtml(
    markdown,
    currentName,
    collectThemeVars(),
    document.documentElement.classList.contains('dark'),
  )
  await saveOrDownload(
    html,
    currentName.replace(/\.(md|markdown)$/i, '') + '.html',
    { name: 'HTML', extensions: ['html'] },
    'text/html;charset=utf-8',
  )
}

/** 浏览器模式的下载兜底（Electron 模式走 native.exportAs 存盘） */
function triggerBrowserDownload(content: string, defaultName: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  a.click()
  URL.revokeObjectURL(url)
}

/** 存盘统一入口：Electron 弹原生保存框写盘；浏览器模式退化为下载 */
async function saveOrDownload(
  content: string,
  defaultName: string,
  filter: { name: string; extensions: string[] },
  mime: string,
) {
  if (native) {
    await native.exportAs({ content, defaultName, filters: [filter] })
  } else {
    triggerBrowserDownload(content, defaultName, mime)
  }
}

/**
 * 导出 LaTeX：纯文本转换（无需离屏渲染，浏览器模式同样可用）。
 * - 公式 $..$ / $$..$$ 原文透传（LaTeX 原生支持）
 * - 中文文档用 ctexart 文档类（需 XeLaTeX 编译）
 * - Mermaid 图表降级为注释保留源码（无离线 LaTeX 方案）
 */
export async function exportLatex(markdown: string, currentName: string) {
  const tex = renderLatexDocument(markdown, currentName)
  await saveOrDownload(
    tex,
    currentName.replace(/\.(md|markdown)$/i, '') + '.tex',
    { name: 'LaTeX', extensions: ['tex'] },
    'application/x-tex;charset=utf-8',
  )
}

/** 导出 PDF：经打印对话框完成（Electron 走主进程打印，浏览器走 window.print） */
export async function exportPdf() {
  if (native) {
    await native.print()
  } else {
    window.print()
  }
}

/**
 * 发起一次离屏导出任务（Word / 长图共用）：
 * 采集当前窗口主题快照与文档目录 → 主进程弹保存框 → 隐藏窗口执行 → 写文件。
 * 取消静默；失败 toast；成功不打扰（与 HTML/PDF 保存反馈一致）。
 */
async function runOffscreenExport(
  kind: ExportTask['kind'],
  markdown: string,
  currentName: string,
  baseDir: string | null,
  extension: string,
  filterLabel: string,
): Promise<void> {
  if (!native) return // 浏览器环境入口已隐藏，防御性返回
  const doc = buildExportDocument(
    markdown,
    currentName,
    collectThemeVars(),
    document.documentElement.classList.contains('dark'),
  )
  const task: ExportTask = { ...doc, kind, baseDir }
  try {
    const result = await native.exportRun({
      task,
      defaultName: currentName.replace(/\.(md|markdown)$/i, '') + '.' + extension,
      filters: [{ name: filterLabel, extensions: [extension] }],
    })
    if (!result) return // 用户在保存框点了取消
  } catch {
    showToast(t('export.failed'))
  }
}

/** 导出当前文档为 Word（.docx） */
export function exportWord(
  markdown: string,
  currentName: string,
  baseDir: string | null,
): Promise<void> {
  return runOffscreenExport('word', markdown, currentName, baseDir, 'docx', 'Word')
}

/** 导出当前文档为整页长图（.png） */
export function exportLongimage(
  markdown: string,
  currentName: string,
  baseDir: string | null,
): Promise<void> {
  return runOffscreenExport('longimage', markdown, currentName, baseDir, 'png', 'PNG')
}
