/**
 * 拖拽打开文件
 *
 * - 拖 .md / .markdown 进窗口：新标签打开（Electron 经磁盘读取，
 *   享受同路径去重与最近列表；浏览器降级为直接读 File 内容）
 * - 拖图片进文档：按粘贴图片策略插入（inline / assets，见 paste-image.ts）
 * - 两者混合拖入时各自处理
 *
 * 监听挂 window 捕获阶段：仅拦截携带文件的拖放（types 含 "Files"），
 * 编辑器内部文本拖拽不受影响；preventDefault 同时阻止浏览器/Electron
 * 用文件触发页面导航。Electron 32+ 的 File 无 path 属性，绝对路径经
 * preload 的 webUtils.getPathForFile 换取。
 *
 * @author chiangyang
 */
import { native } from './native'
import { openFromData, openPath, showToast } from './files'
import { insertImageFiles } from './paste-image'
import { getPmView, isSourceMode } from './editor-core'
import { t } from './i18n'

const MD_EXTS = ['.md', '.markdown']

/** 拖入文件分类：markdown 待打开，图片待插入；其余忽略 */
export function classifyDroppedFiles(files: File[]): { markdown: File[]; images: File[] } {
  const markdown: File[] = []
  const images: File[] = []
  for (const file of files) {
    const lower = file.name.toLowerCase()
    if (MD_EXTS.some((ext) => lower.endsWith(ext))) markdown.push(file)
    else if (file.type.startsWith('image/')) images.push(file)
  }
  return { markdown, images }
}

/** 处理一次拖放：md 逐个打开，图片插入当前文档 */
async function handleDrop(files: File[]) {
  const { markdown, images } = classifyDroppedFiles(files)

  const view = getPmView()
  if (images.length) {
    if (view && !isSourceMode()) {
      await insertImageFiles(view, images)
    } else {
      // 源码模式（或编辑器未就绪）不支持插入图片：明确提示，避免拖入后毫无反馈
      showToast(t('files.imageDropInSource'))
    }
  }

  for (const file of markdown) {
    const path = native?.getPathForFile(file)
    if (path) {
      await openPath(path)
    } else {
      // 浏览器降级：File 无路径可读，直接读内容（无同路径去重，属预期）
      const content = await file.text()
      await openFromData({ name: file.name, content })
    }
  }
}

/** 装配窗口级拖拽监听（boot 时调用一次） */
export function wireDragDrop(): void {
  // dragover 必须 preventDefault 才允许 drop 事件发生
  window.addEventListener(
    'dragover',
    (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    },
    true,
  )
  window.addEventListener(
    'drop',
    (e) => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return // 无文件的拖放（如编辑器内部文本拖拽）交回默认处理
      e.preventDefault()
      e.stopPropagation()
      void handleDrop(files)
    },
    true,
  )
}
