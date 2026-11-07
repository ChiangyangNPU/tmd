/**
 * 源码模式：CodeMirror 6 懒加载壳。
 *
 * CodeMirror 6 全家（压缩后约 300-400KB）只有源码/分屏模式才真正执行，静态
 * 引入却会随 editor-core 进启动包（性能验证 2026-11-07：主包 1.08MB 拆分）。
 * 重实现整体在 ./sourcemode-cm，此处仅保留动态导入 trampoline：模块级单例
 * Promise 缓存（mermaid.ts 同款），装载失败清缓存允许下次重试。
 *
 * @author chiangyang
 */
import type { EditorView as CMView } from 'codemirror'

let cmModule: Promise<typeof import('./sourcemode-cm')> | null = null

function loadCmModule(): Promise<typeof import('./sourcemode-cm')> {
  cmModule ??= import('./sourcemode-cm').catch((err: unknown) => {
    cmModule = null
    throw err
  })
  return cmModule
}

/**
 * 创建 CodeMirror 编辑器实例挂到 parent（异步：首次调用装载 CodeMirror 模块）
 *
 * @param parent - 挂载容器
 * @param markdown - markdown 全文
 * @param editable - 是否可编辑（分屏的只读跟随侧传 false：文本仍可选中复制，但不能输入）
 * @param onDocChange - 文档变更回调（分屏时用于把改动同步给另一侧）
 * @returns CodeMirror 视图实例
 */
export async function createSourceEditor(
  parent: HTMLElement,
  markdown: string,
  editable = true,
  onDocChange?: (markdown: string) => void,
): Promise<CMView> {
  const { createSourceEditor: createImpl } = await loadCmModule()
  return createImpl(parent, markdown, editable, onDocChange)
}
