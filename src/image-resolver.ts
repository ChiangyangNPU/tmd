/**
 * 相对路径图片的显示解析
 *
 * 设计：文档内容里图片始终保存相对路径（assets/xxx.png，便于迁移与 GitHub 展示），
 * 显示时由本插件的节点装饰把 src 解析为当前文档目录下的绝对 file:// 地址。
 * 文档数据本身不变，序列化/保存的仍是相对路径。
 *
 * baseDir 随激活标签页的文件目录变化（main.ts 在标题刷新时同步）。
 *
 * 刷新时机：baseDir 是存在插件闭包里的外部状态，不随编辑器 state 流转，已挂载
 * 的视图不会自动感知它的变化。setImageBaseDir 在目录变化时向存活视图派发一个
 * 不改文档的纯 meta 事务，强制 ProseMirror 重算 decorations 并刷新各图片视图；
 * 否则「打开文件」路径上编辑器先构建、baseDir 后设置，图片要等到下一次事务
 * （如点击图片）才显示。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { toFileUrl } from './fs-path'

let baseDir: string | null = null

/** 当前挂载本插件的视图；编辑器重建间隙（先销毁旧实例）可能短暂为 null */
let activeView: EditorView | null = null

/** baseDir 变更通道：setImageBaseDir 借它派发纯 meta 事务触发装饰重算 */
const imageBaseDirKey = new PluginKey('tmd-image-base-dir')

/** main.ts 在激活标签页变化时同步文档所在目录 */
export function setImageBaseDir(dir: string | null) {
  if (baseDir === dir) return
  baseDir = dir
  // 纯 meta 事务不改文档：docChanged=false，既不进撤销栈，也不触发 milkdown
  // listener 的 updated 回调（不会置脏 / 触发 markdown 序列化），仅让
  // ProseMirror 重新调用 decorations 并把新 src 装饰下发给各 ImageView。
  // 视图尚不存在（编辑器构建前）或已销毁时无需派发——构建期会直接读到最新 baseDir。
  const view = activeView
  if (view && !view.isDestroyed) {
    view.dispatch(view.state.tr.setMeta(imageBaseDirKey, dir))
  }
}

/** 是否为需要解析的相对路径（排除 data:/http(s):/file:/根相对） */
function isRelativeSrc(src: unknown): boolean {
  return typeof src === 'string' && src !== '' && !/^(data:|https?:|file:|\/)/i.test(src)
}

/** 图片路径解析插件：显示时把相对路径 src 解析为 file:// 绝对地址（节点装饰，文档数据不变） */
export const imageSrcResolver = $prose(
  () =>
    new Plugin({
      key: imageBaseDirKey,
      view(view) {
        activeView = view
        return {
          destroy() {
            // 仅当自己仍是登记视图时才清空，避免重建间隙新视图注册后被旧视图销毁误清
            if (activeView === view) activeView = null
          },
        }
      },
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
