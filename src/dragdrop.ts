/**
 * 拖拽打开文件
 *
 * - 拖 .md / .markdown / .txt 进窗口：新标签打开（Electron 经磁盘读取，
 *   享受同路径去重与最近列表；浏览器降级为直接读 File 内容）
 * - 拖图片进文档：按粘贴图片策略插入（inline / assets，见 paste-image.ts）
 * - 两者混合拖入时各自处理
 *
 * 监听挂 window 捕获阶段：仅拦截携带文件的拖放（types 含 "Files"），
 * 编辑器内部文本拖拽不受影响；preventDefault 同时阻止浏览器/Electron
 * 用文件触发页面导航。Electron 32+ 的 File 无 path 属性，绝对路径经
 * preload 的 webUtils.getPathForFile 换取；Tauri 壳走 onDropPaths 原生
 * 路径事件（dragDropEnabled 拦截下 HTML5 drop 不携带文件）。
 *
 * @author chiangyang
 */
import { native } from './native'
import { openFromData, openPath, showToast } from './files'
import { insertImageFiles } from './paste-image'
import { getPmView, isSourceMode } from './editor-core'
import { t } from './i18n'

const MD_EXTS = ['.md', '.markdown', '.txt']

/** 图片扩展名白名单（与 Rust tmd_read_dropped_file 的 IMAGE_MIME 同口径） */
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i

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

/**
 * Tauri 壳的拖放处理：文件拖放经原生拦截（dragDropEnabled 默认开启），
 * HTML5 drop 拿不到文件，路径经 onDropPaths 下发——md 按路径打开（与
 * Electron 的路径流同款：同路径去重、最近列表、编码保持），图片经
 * readDroppedFile 白名单读盘后构造 File 复用粘贴图片插入链。
 */
async function handleDroppedPaths(paths: string[]): Promise<void> {
  const markdown = paths.filter((p) => MD_EXTS.some((ext) => p.toLowerCase().endsWith(ext)))
  const images = paths.filter((p) => IMAGE_EXTS.test(p))

  const view = getPmView()
  if (images.length) {
    if (view && !isSourceMode()) {
      const files: File[] = []
      for (const path of images) {
        const data = await native?.readDroppedFile?.(path)
        if (!data) continue // 白名单外 / 超限 / 读盘失败：跳过
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
        files.push(new File([bytes], data.name, { type: data.mime }))
      }
      if (files.length) await insertImageFiles(view, files)
    } else {
      showToast(t('files.imageDropInSource'))
    }
  }

  for (const path of markdown) await openPath(path)
}

/** 装配窗口级拖拽监听（boot 时调用一次） */
export function wireDragDrop(): void {
  // Tauri 壳：走原生路径事件，不再挂 HTML5 文件监听（拦截下收不到文件拖放，
  // 也避免未来配置放开后两条链路重复处理）
  if (native?.onDropPaths) {
    native.onDropPaths((paths) => {
      if (!paths.length) return
      void handleDroppedPaths(paths).catch((err) => console.error('[tmd] 拖放处理失败', err))
    })
    return
  }
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
      // 文件读取/打开失败（浏览器降级路径的 file.text() 等）不能成为未捕获 rejection
      void handleDrop(files).catch((err) => console.error('[tmd] 拖放处理失败', err))
    },
    true,
  )
}
