/**
 * 查找替换（所见即所得模式）
 *
 * 匹配在「连续文本段」内跨节点进行——格式标记不阻断（`**bo**ld` 能搜到 bold），
 * 但不跨段落，也不跨越行内原子节点（图片 / 脚注引用 / 硬换行）。与 Typora 同一
 * 取舍：替换不会合并段落，也不会跨原子节点产生不确定结果。
 * 支持正则模式（固定大小写不敏感），替换串可用 $& / $1-$9 引用捕获组。
 * 源码模式使用 CodeMirror 自带的搜索面板。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { scrollEditorPosIntoView } from './toc'

/** 单个匹配项在文档中的位置区间；正则模式额外带命中原文与捕获组（供替换串展开） */
export interface MatchRange {
  from: number
  to: number
  /** 正则模式：命中的原文（对应替换串里的 $&） */
  raw?: string
  /** 正则模式：捕获组（对应 $1-$9），未参与匹配的可选组为 undefined */
  groups?: (string | undefined)[]
}

/** 查找选项 */
export interface FindOptions {
  /** 正则模式（大小写不敏感固定开启，与普通查找语义一致） */
  regex?: boolean
}

/** 单次查找的匹配数上限：正则回溯或超长文档下，避免界面被逐项高亮拖垮 */
const MAX_MATCHES = 2000

/** 连续文本段：一段可跨节点匹配的线性文本，及其文本节点到文档位置的映射 */
interface TextSegment {
  text: string
  /** 每个文本节点在线性文本中的起点与对应的文档位置 */
  parts: { textStart: number; pos: number; length: number }[]
}

/**
 * 按「连续文本段」收集线性文本与位置映射。
 *
 * 文本块（段落 / 标题 / 代码块）边界与行内原子节点都会断开分段：前者保证不跨
 * 段落匹配，后者避免匹配与替换跨越图片 / 脚注引用 / 硬换行（装饰与替换跨原子
 * 节点的行为不确定）。格式标记（加粗、斜体等 mark）不产生新节点，不会断开。
 */
function collectTextSegments(doc: ProseNode): TextSegment[] {
  const segments: TextSegment[] = []
  /** 当前段；遇到块或原子节点置空，下个文本节点重新开段 */
  let current: TextSegment | null = null
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      current = { text: '', parts: [] }
      segments.push(current)
      return true
    }
    if (node.isText) {
      if (node.text) {
        if (!current) {
          current = { text: '', parts: [] }
          segments.push(current)
        }
        current.parts.push({ textStart: current.text.length, pos, length: node.text.length })
        current.text += node.text
      }
      return false
    }
    if (node.isInline) current = null
    return true
  })
  return segments
}

/** 线性文本偏移 → 文档位置；偏移落在映射之外时返回 null（调用方跳过该匹配） */
function toDocPos(segment: TextSegment, offset: number): number | null {
  for (const part of segment.parts) {
    if (offset >= part.textStart && offset <= part.textStart + part.length) {
      return part.pos + (offset - part.textStart)
    }
  }
  return null
}

/**
 * 把线性文本中的 [start, end) 映射为文档区间并收集结果。
 * @returns 是否继续匹配（超过上限时返回 false 让调用方停止）
 */
function collect(
  segment: TextSegment,
  start: number,
  end: number,
  out: MatchRange[],
  extra?: { raw: string; groups: (string | undefined)[] },
): boolean {
  if (out.length >= MAX_MATCHES) return false
  const from = toDocPos(segment, start)
  const to = toDocPos(segment, end)
  // 映射不到文档位置（理论上不会发生）：跳过该匹配，不影响其余结果
  if (from == null || to == null) return true
  out.push(extra ? { from, to, ...extra } : { from, to })
  return true
}

/** 普通模式：段内大小写不敏感的字面子串匹配（可跨格式标记） */
function matchLiteral(segment: TextSegment, query: string, out: MatchRange[]): boolean {
  const haystack = segment.text.toLowerCase()
  // toLowerCase 对个别字符会改变长度（如 'İ' → 'i̇'），此时小写串的下标无法映射回
  // 原文，退回大小写敏感匹配，保证区间始终落在原文的准确位置
  const sameLength = haystack.length === segment.text.length
  const source = sameLength ? haystack : segment.text
  const pattern = sameLength ? query.toLowerCase() : query
  let idx = source.indexOf(pattern)
  while (idx !== -1) {
    if (!collect(segment, idx, idx + pattern.length, out)) return false
    idx = source.indexOf(pattern, idx + pattern.length)
  }
  return true
}

/** 正则模式：段内全局匹配，并携带捕获组供替换串展开 */
function matchRegexp(segment: TextSegment, re: RegExp, out: MatchRange[]): boolean {
  re.lastIndex = 0
  let m: RegExpExecArray | null = re.exec(segment.text)
  while (m) {
    if (m[0] === '') {
      // 空匹配（如 a*）：前移一位继续，避免死循环
      re.lastIndex++
      m = re.exec(segment.text)
      continue
    }
    const ok = collect(segment, m.index, m.index + m[0].length, out, {
      raw: m[0],
      groups: m.slice(1),
    })
    if (!ok) return false
    m = re.exec(segment.text)
  }
  return true
}

/**
 * 编译查找表达式（正则模式用，固定大小写不敏感）。
 * @returns 非法表达式返回 null（由查找栏提示，不抛错）
 */
export function compileQuery(query: string): RegExp | null {
  try {
    return new RegExp(query, 'gi')
  } catch {
    return null
  }
}

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
  // 同 matchLiteral：小写化改变长度时退回大小写敏感匹配
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

/**
 * 在文档中查找 query 的所有出现位置（段内跨节点，大小写不敏感）。
 * @param doc - 文档根节点
 * @param query - 关键词或正则表达式；为空时返回空数组
 * @param options - regex 为真时按正则匹配（表达式非法时返回空数组）
 */
export function findMatches(
  doc: ProseNode,
  query: string,
  options: FindOptions = {},
): MatchRange[] {
  if (!query) return []
  const results: MatchRange[] = []
  const segments = collectTextSegments(doc)
  if (options.regex) {
    const re = compileQuery(query)
    if (!re) return []
    for (const segment of segments) {
      if (!matchRegexp(segment, re, results)) break
    }
  } else {
    for (const segment of segments) {
      if (!matchLiteral(segment, query, results)) break
    }
  }
  return results
}

/**
 * 展开替换串中的捕获组引用（仅正则模式）：$& 为命中原文、$1-$9 为捕获组、
 * $$ 为字面 $。普通模式的替换串按字面处理（与既有行为一致）。
 * 导出供单元测试覆盖。
 */
export function expandReplacement(match: MatchRange, replacement: string): string {
  if (match.groups == null) return replacement
  return replacement.replace(/\$(\$|&|\d)/g, (whole, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return match.raw ?? ''
    const idx = Number(token)
    if (idx === 0) return whole
    return match.groups?.[idx - 1] ?? ''
  })
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

interface FindState {
  query: string
  options: FindOptions
  matches: MatchRange[]
  index: number
}

let state: FindState = { query: '', options: {}, matches: [], index: -1 }

/**
 * 重算匹配列表并把当前序号停在指定位置（clamp 到有效范围）。
 * 无匹配时序号保持 -1，与 findSetQuery 的不变量一致。
 */
function recompute(
  view: EditorView,
  query: string,
  options: FindOptions,
  index: number,
): FindState {
  const matches = findMatches(view.state.doc, query, options)
  const next = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1
  state = { query, options, matches, index: next }
  sync(view)
  return state
}

/** 设置查找词：重算匹配列表并定位到第一个匹配 */
export function findSetQuery(view: EditorView, query: string, options: FindOptions = {}) {
  return recompute(view, query, options, 0)
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
  const match = state.matches[state.index]
  const { query, options } = state
  const index = state.index
  // 同 findReplaceAll：先清空匹配列表，避免 dispatch 那一帧沿用已被替换掉的旧区间
  state = { query, options, matches: [], index: -1 }
  view.dispatch(
    view.state.tr.insertText(expandReplacement(match, replacement), match.from, match.to),
  )
  return recompute(view, query, options, index)
}

/** 替换全部匹配项并重算（内部从后往前替换，避免位置偏移） */
export function findReplaceAll(view: EditorView, replacement: string): FindState {
  if (!state.matches.length) return state
  const { query, options } = state
  const tr = view.state.tr
  // 从后往前替换，避免位置偏移
  for (const match of [...state.matches].sort((a, b) => b.from - a.from)) {
    tr.insertText(expandReplacement(match, replacement), match.from, match.to)
  }
  // dispatch 前先清空匹配列表：该帧装饰器会重算，若沿用已被替换掉的旧区间，
  // 会算出错误甚至越界的高亮（紧随其后的 recompute 再填回正确结果）
  state = { query, options, matches: [], index: -1 }
  view.dispatch(tr)
  return recompute(view, query, options, 0)
}

/** 清空查找状态并移除高亮 */
export function findClear(view: EditorView | null) {
  state = { query: '', options: {}, matches: [], index: -1 }
  if (view) sync(view)
}

/** 供 UI 读取当前状态（匹配列表、序号、生效选项） */
export function findState(): FindState {
  return state
}
