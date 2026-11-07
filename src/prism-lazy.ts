/**
 * 代码高亮插件（@milkdown/plugin-prism 的 vendor 版，refractor 懒加载）。
 *
 * 为什么 vendor：refractor（全语言，压缩后约 150-250KB）被原包静态 import，
 * 随编辑器进启动包——而高亮只有文档出现代码块才真正需要。本模块与其逐行
 * 等价的差异只有一处：refractor 经动态 import 懒加载，加载完成前装饰集为
 * 空（代码块短暂显示无高亮纯文本），就绪后补一次重装饰。
 *
 * 触发策略：文档中存在 code_block 时才发起加载——不含代码的文档永远不加载。
 * schema/装饰算法/增量重算逻辑与 @milkdown/plugin-prism@7.22.1 逐行等价
 * （只重命名导出），configureRefractor ctx 原样保留。
 *
 * @author chiangyang
 */
import { findChildren } from '@milkdown/kit/prose'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $ctx, $prose } from '@milkdown/kit/utils'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** refractor 5 为纯 JS 包（无类型声明），按实际用到的面做结构化类型 */
type RefractorNode = {
  type: string
  value?: string
  children?: RefractorNode[]
  properties?: { className?: string[] }
}
type RefractorLike = {
  highlight(code: string, language: string): RefractorNode
  listLanguages(): string[]
}
type RefractorModule = { refractor: RefractorLike }

// refractor 懒加载单例（mermaid.ts 同款：失败清缓存允许重试）
let refractorModule: Promise<RefractorModule> | null = null
/** 就绪的 refractor 实例；未就绪为 null（装饰集走空集） */
let refractorInstance: RefractorLike | null = null
/** 已发起加载（防重复拉起；失败后复位） */
let loading = false

function ensureRefractor(doc: ProseNode, onReady: () => void): void {
  if (refractorInstance || loading) return
  const hasCodeBlock = findChildren((n) => n.type.name === 'code_block')(doc).length > 0
  if (!hasCodeBlock) return
  loading = true
  refractorModule = (import('refractor') as Promise<RefractorModule>).catch((err: unknown) => {
    refractorModule = null
    loading = false
    throw err
  })
  void refractorModule
    .then((mod) => {
      refractorInstance = mod.refractor
      onReady()
    })
    .catch((err: unknown) => {
      console.error('[tmd] 代码高亮模块加载失败', err)
    })
}

const prismConfig = $ctx<{ configureRefractor: (refractor: RefractorLike) => RefractorLike | null | undefined }, 'prismConfig'>(
  { configureRefractor: () => undefined },
  'prismConfig',
)
prismConfig.meta = {
  package: '@milkdown/plugin-prism',
  displayName: 'Ctx<prism>',
}

function flatNodes(nodes: unknown[], className: string[] = []): { text: string; className: string[] }[] {
  return nodes.flatMap((node) =>
    (node as { type: string; children?: unknown[]; properties?: { className?: string[] }; value?: string }).type ===
    'element'
      ? flatNodes(
          (node as { children?: unknown[] }).children ?? [],
          [...className, ...((node as { properties?: { className?: string[] } }).properties?.className ?? [])],
        )
      : [{ text: (node as { value?: string }).value ?? '', className }],
  )
}

function getBlockDecorations(node: ProseNode, pos: number, refractor: RefractorLike): Decoration[] {
  const languages = refractor.listLanguages()
  const { language } = node.attrs as { language?: string }
  if (!language || !languages.includes(language)) {
    console.warn('Unsupported language detected, this language has not been supported by current prism config: ', language)
    return []
  }
  const decorations: Decoration[] = []
  let from = pos + 1
  flatNodes(refractor.highlight(node.textContent, language).children ?? []).forEach((child) => {
    const to = from + child.text.length
    if (child.className.length) decorations.push(Decoration.inline(from, to, { class: child.className.join(' ') }))
    from = to
  })
  return decorations
}

function getDecorations(doc: ProseNode, name: string, refractor: RefractorLike): DecorationSet {
  const decorations = findChildren((node) => node.type.name === name)(doc).flatMap((block) =>
    getBlockDecorations(block.node, block.pos, refractor),
  )
  return DecorationSet.create(doc, decorations)
}

function changedTextblock(prev: ProseNode, next: ProseNode): { node: ProseNode; pos: number } | null {
  const from = prev.content.findDiffStart(next.content)
  if (from == null) return null
  const diff = prev.content.findDiffEnd(next.content)
  if (!diff) return null
  const to = Math.max(diff.b, from)
  const $from = next.resolve(from)
  const $to = next.resolve(to)
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  return {
    node: $from.parent,
    pos: $from.before($from.depth),
  }
}

const PRISM_NAME = 'code_block'
/** 重装饰信号：refractor 就绪后经该 meta 触发一次全量重算 */
const RELOAD_META = 'MILKDOWN_PRISM_LAZY_RELOAD'

const prismLazyPlugin = $prose((ctx) => {
  const { configureRefractor } = ctx.get(prismConfig.key)
  const name = PRISM_NAME
  let viewRef: EditorView | null = null
  const requestRedecorate = () => {
    if (viewRef) viewRef.dispatch(viewRef.state.tr.setMeta(RELOAD_META, true))
  }

  return new Plugin({
    key: new PluginKey('MILKDOWN_PRISM_LAZY'),
    state: {
      init: (_, { doc }) => {
        ensureRefractor(doc, requestRedecorate)
        return refractorInstance ? getDecorations(doc, name, refractorInstance) : DecorationSet.empty
      },
      apply: (transaction, decorationSet, oldState, state) => {
        if (!refractorInstance) {
          ensureRefractor(state.doc, requestRedecorate)
          return DecorationSet.empty
        }
        const instance = configureRefractor(refractorInstance) ?? refractorInstance
        if (transaction.getMeta(RELOAD_META)) return getDecorations(transaction.doc, name, instance)
        if (!transaction.docChanged) return decorationSet
        const edited = changedTextblock(oldState.doc, state.doc)
        if (edited) {
          const mapped = decorationSet.map(transaction.mapping, transaction.doc)
          if (edited.node.type.name !== name) return mapped
          const from = edited.pos
          const to = from + edited.node.nodeSize
          return mapped.remove(mapped.find(from + 1, to - 1)).add(transaction.doc, getBlockDecorations(edited.node, from, instance))
        }
        const isNodeName = state.selection.$head.parent.type.name === name
        const isPreviousNodeName = oldState.selection.$head.parent.type.name === name
        if (
          isNodeName ||
          isPreviousNodeName ||
          (() => {
            const oldNode = findChildren((node) => node.type.name === name)(oldState.doc)
            const newNode = findChildren((node) => node.type.name === name)(state.doc)
            return (
              oldNode.length !== newNode.length ||
              oldNode.some((entry, i) => entry.node.attrs.language !== newNode[i]?.node.attrs.language) ||
              transaction.steps.some((step) => {
                const s = step as { from?: number; to?: number }
                return (
                  s.from !== undefined &&
                  s.to !== undefined &&
                  oldNode.some((node) => node.pos >= s.from! && node.pos + node.node.nodeSize <= s.to!)
                )
              })
            )
          })()
        )
          return getDecorations(transaction.doc, name, instance)
        return decorationSet.map(transaction.mapping, transaction.doc)
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
    },
    view(editorView) {
      viewRef = editorView
      return {
        destroy() {
          viewRef = null
        },
      }
    },
  })
})
prismLazyPlugin.meta = {
  package: '@milkdown/plugin-prism',
  displayName: 'Prose<prism>',
}

export const prismLazy = [prismLazyPlugin, prismConfig]
