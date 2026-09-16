/**
 * 相对路径图片的显示解析
 *
 * 设计：文档内容里图片始终保存相对路径（assets/xxx.png，便于迁移与 GitHub 展示），
 * 显示时由本插件的节点装饰把 src 解析为当前文档目录下的绝对 file:// 地址。
 * 文档数据本身不变，序列化/保存的仍是相对路径。
 *
 * baseDir 随激活标签页的文件目录变化（main.ts 在标题刷新时同步）。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

let baseDir: string | null = null

/** main.ts 在激活标签页变化时同步文档所在目录 */
export function setImageBaseDir(dir: string | null) {
  baseDir = dir
}

/** 是否为需要解析的相对路径（排除 data:/http(s):/file:/根相对） */
function isRelativeSrc(src: unknown): boolean {
  return typeof src === 'string' && src !== '' && !/^(data:|https?:|file:|\/)/i.test(src)
}

/**
 * 把文档目录与相对路径拼成可直接用于 img.src 的 file:// URL。
 * 反斜杠统一为正斜杠（Windows 路径）；非根路径补前导斜杠；
 * '#' 需转义为 %23，否则会被浏览器当作 URL 片段截断文件名。
 * @param dir - 文档所在目录的绝对路径
 * @param src - 文档内保存的相对路径（如 assets/xxx.png）
 * @returns file:// 开头的绝对地址
 */
function toFileUrl(dir: string, src: string): string {
  const normalized = `${dir.replaceAll('\\', '/')}/${src.replaceAll('\\', '/')}`
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replaceAll('#', '%23')}`
}

/** 图片路径解析插件：显示时把相对路径 src 解析为 file:// 绝对地址（节点装饰，文档数据不变） */
export const imageSrcResolver = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (state) => {
          if (!baseDir) return DecorationSet.empty
          const dir = baseDir // 闭包内无法收窄类型，先固化
          const decos: Decoration[] = []
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && isRelativeSrc(node.attrs.src)) {
              // 节点装饰覆盖显示用 src；文档数据保持相对路径不变
              decos.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  src: toFileUrl(dir, node.attrs.src as string),
                }),
              )
            }
            return true
          })
          return DecorationSet.create(state.doc, decos)
        },
      },
    }),
)
