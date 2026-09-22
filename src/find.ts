/**
 * 查找替换（所见即所得模式）
 *
 * 通过 ProseMirror 装饰器高亮所有匹配项；不处理跨节点匹配（v1.0 的合理简化）。
 * 源码模式使用 CodeMirror 自带的搜索面板。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { scrollEditorPosIntoView } from './toc'

/** 单个匹配项在文档中的位置区间 */
export interface MatchRange {
  from: number
  to: number
}

interface FindState {
  query: string
  matches: MatchRange[]
  index: number
}

let state: FindState = { query: '', matches: [], index: -1 }

/**
 * 在纯文本中查找 query 的所有出现位置（大小写不敏感，纯函数）。
 * 供源码模式复用「在实时文档内重新匹配」的定位策略：磁盘文件的行号与编辑器内
 * 的实时文档不能换算（进入源码模式前 markdown 经过序列化，源码文档又可能已被
 * 编辑），故与 ProseMirror 侧同一思路——拿关键词在实时文本里重新数一遍。
 * @param text - 待查找的纯文本
 * @param query - 关键词；为空时返回空数组
 * @returns 匹配区间数组（from/to 为文本下标）
 */
export function findTextRanges(text: string, query: string): MatchRange[] {
  if (!query) return []
  const results: MatchRange[] = []
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  // toLowerCase 对个别字符会改变长度（如 'İ' → 'i̇'），此时小写串的下标无法
  // 映射回原文，退回大小写敏感匹配，保证区间始终落在原文的准确位置
  const sameLength = haystack.length === text.length
  const source = sameLength ? haystack : text
  const pattern = sameLength ? needle : query
  let idx = source.indexOf(pattern)
  while (idx !== -1) {
    results.push({ from: idx, to: idx + pattern.length })
    idx = source.indexOf(pattern, idx + pattern.length)
  }
  return results
}

/** 在全文中查找 query 的所有出现位置（大小写不敏感；不跨节点，仅匹配单个文本节点内） */
export function findMatches(doc: ProseNode, query: string): MatchRange[] {
  if (!query) return []
  const results: MatchRange[] = []
  const needle = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const haystack = node.text.toLowerCase()
    // 同 findTextRanges：小写化改变长度时退回大小写敏感匹配，避免位置偏移
    const sameLength = haystack.length === node.text.length
    const source = sameLength ? haystack : node.text
    const pattern = sameLength ? needle : query
    let idx = source.indexOf(pattern)
    while (idx !== -1) {
      results.push({ from: pos + idx, to: pos + idx + pattern.length })
      idx = source.indexOf(pattern, idx + pattern.length)
    }
    return true
  })
  return results
}

/**
 * 触发一次无变更事务，让查找装饰器重新计算高亮。
 * 装饰器只在事务中重算，故查询词或当前项变化后需借此刷新视图。
 * @param view - 编辑器视图
 */
function sync(view: EditorView) {
  view.dispatch(view.state.tr.setMeta('find-update', true))
}

/** 查找高亮插件：全部匹配项加 find-hit 类，当前项追加 find-current */
export const findPlugin = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (s) => {
          if (!state.query || !state.matches.length) return DecorationSet.empty
          const decos = state.matches.map((m, i) =>
            Decoration.inline(m.from, m.to, {
              class: i === state.index ? 'find-hit find-current' : 'find-hit',
            }),
          )
          return DecorationSet.create(s.doc, decos)
        },
      },
    }),
)

/**
 * 重算匹配列表并把当前序号停在指定位置（clamp 到有效范围）。
 * 无匹配时序号保持 -1，与 findSetQuery 的不变量一致。
 */
function recompute(view: EditorView, query: string, index: number): FindState {
  const matches = findMatches(view.state.doc, query)
  const next = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1
  state = { query, matches, index: next }
  sync(view)
  return state
}

/** 设置查找词：重算匹配列表并定位到第一个匹配 */
export function findSetQuery(view: EditorView, query: string) {
  return recompute(view, query, 0)
}

/** 跳到上/下一个匹配（循环），选中并滚动到目标位置 */
export function findStep(view: EditorView, delta: 1 | -1): FindState {
  if (!state.matches.length) return state
  state.index = (state.index + delta + state.matches.length) % state.matches.length
  const match = state.matches[state.index]
  const selection = TextSelection.create(view.state.doc, match.from, match.to)
  view.dispatch(view.state.tr.setSelection(selection))
  // ProseMirror 自带的 tr.scrollIntoView() 对自定义滚动容器（.page-scroll）不生效，
  // 改用手动计算滚动量的共用工具（toc / outline 亦用之）
  scrollEditorPosIntoView(view, selection.from)
  sync(view)
  return state
}

/** 替换当前匹配项，随后重算匹配列表（序号停在原位 = 下一个匹配，便于连续替换） */
export function findReplaceCurrent(view: EditorView, replacement: string): FindState {
  if (state.index < 0 || !state.matches[state.index]) return state
  const { from, to } = state.matches[state.index]
  const index = state.index
  view.dispatch(view.state.tr.insertText(replacement, from, to))
  return recompute(view, state.query, index)
}

/** 替换全部匹配项并重算（内部从后往前替换，避免位置偏移） */
export function findReplaceAll(view: EditorView, replacement: string): FindState {
  if (!state.matches.length) return state
  const query = state.query
  const tr = view.state.tr
  // 从后往前替换，避免位置偏移
  for (const match of [...state.matches].sort((a, b) => b.from - a.from)) {
    tr.insertText(replacement, match.from, match.to)
  }
  // dispatch 前先清空匹配列表：该帧装饰器会重算，若沿用已被替换掉的旧区间，
  // 会算出错误甚至越界的高亮（紧随其后的 recompute 再填回正确结果）
  state = { query, matches: [], index: -1 }
  view.dispatch(tr)
  return recompute(view, query, 0)
}

/** 清空查找状态并移除高亮 */
export function findClear(view: EditorView | null) {
  state = { query: '', matches: [], index: -1 }
  if (view) sync(view)
}

/** 供 UI 读取当前匹配数量与索引 */
export function findState(): FindState {
  return state
}
