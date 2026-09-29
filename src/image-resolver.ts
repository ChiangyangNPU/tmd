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
 * 性能优化（§26.5）：原版每次事务都全量遍历文档找图片节点（O(文档节点数)），
 * 现改为 plugin state 缓存 DecorationSet + apply 增量更新——纯文本输入时只做
 * O(图片数) 的位置映射 + O(变更范围) 的局部扫描，大文档（数千段落、几十张图）
 * 下从每次按键的 O(n) 降到 O(图片数)。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { type EditorState, Plugin, PluginKey, type StateField } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import { toFileUrl } from './fs-path'

let baseDir: string | null = null

/** 当前挂载本插件的视图；编辑器重建间隙（先销毁旧实例）可能短暂为 null */
let activeView: EditorView | null = null

/** baseDir 变更通道：setImageBaseDir 借它派发纯 meta 事务触发装饰重算 */
const imageBaseDirKey = new PluginKey<DecorationSet>('tmd-image-base-dir')

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

/** 全量构建图片装饰集：遍历文档找所有相对路径图片并创建节点装饰 */
function buildDecos(doc: Node, dir: string | null): DecorationSet {
  if (!dir) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'image' && isRelativeSrc(node.attrs.src)) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          src: toFileUrl(dir, node.attrs.src as string),
        }),
      )
    }
    return true
  })
  return DecorationSet.create(doc, decos)
}

/** 在变更范围内扫描图片节点，返回需要添加的装饰列表 */
function scanRangeForImages(doc: Node, from: number, to: number, dir: string): Decoration[] {
  const decos: Decoration[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'image' && isRelativeSrc(node.attrs.src)) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          src: toFileUrl(dir, node.attrs.src as string),
        }),
      )
    }
    return true
  })
  return decos
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
      state: {
        // 初始化：全量扫描文档构建装饰集（编辑器构建时调用一次）
        init(_, state) {
          return buildDecos(state.doc, baseDir)
        },
        // 增量更新：baseDir 变更→全量重建；文档变更→map + 变更范围局部扫描
        apply(
          tr,
          oldDecos: DecorationSet,
          _oldState: EditorState,
          newState: EditorState,
        ): DecorationSet {
          // baseDir 变更：全量重建（setImageBaseDir 派发的纯 meta 事务走此分支）
          if (tr.getMeta(imageBaseDirKey) !== undefined) {
            return buildDecos(newState.doc, baseDir)
          }
          if (!baseDir) return DecorationSet.empty
          if (!tr.docChanged) return oldDecos
          // 映射已有装饰到新文档位置（O(图片数)，纯文本输入时图片节点不变，
          // 仅位置偏移由 DecorationSet.map 自动处理）
          let mapped = oldDecos.map(tr.mapping, newState.doc)
          // 变更范围内可能有新增/删除的图片节点（粘贴图片、编辑 markdown 图片语法等），
          // 局部扫描该范围重建装饰——changedRange() 返回覆盖所有 ReplaceStep 的单一区间
          const range = tr.changedRange()
          if (range) {
            const existing = mapped.find(range.from, range.to)
            if (existing.length) mapped = mapped.remove(existing)
            const newDecos = scanRangeForImages(newState.doc, range.from, range.to, baseDir)
            if (newDecos.length) mapped = mapped.add(newState.doc, newDecos)
          }
          // changedRange() 返回 null（mark/attr-only 变更）时：
          // 图片 src 不会因 mark/attr 变更而改变，mapped 仍有效
          return mapped
        },
      } satisfies StateField<DecorationSet>,
      props: {
        decorations: (state) => imageBaseDirKey.getState(state) ?? DecorationSet.empty,
      },
    }),
)
