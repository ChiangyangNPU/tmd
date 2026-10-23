/**
 * AI 选区动作：提示词构造、选区捕获、结果落地。
 *
 * 设计要点：
 * - 提示词是纯函数，便于单测；服务商、模型、温度等连接参数一律由主进程提供
 * - 发送内容只有「用户显式选中的文本」，字数在气泡里明示，不做隐式上下文收集
 * - 结果落地是单个 ProseMirror 事务（见 editor-core.applyMarkdownRange），
 *   Cmd+Z 一步撤销；流式过程中绝不写编辑器
 *
 * @author chiangyang
 */
import type { AiChatMessage } from './native'
import type { EditorView } from '@milkdown/kit/prose/view'
import { applyMarkdownRange, getPmView } from './editor-core'

/** 选区行内动作标识（与语言包 ai.actions.* 一一对应） */
export type AiActionId =
  'polish' | 'rewrite' | 'shorten' | 'expand' | 'translate' | 'proofread' | 'normalize'

/** 单个动作的定义：界面文案 + 给模型的指令 */
export interface AiActionDef {
  id: AiActionId
  /** 按钮与命令面板的 i18n 键 */
  labelKey: string
  /** 指令正文（英文，模型指令不随界面语言变化，避免指令与界面文案耦合） */
  instruction: string
}

/**
 * 内置动作表：顺序即气泡按钮顺序。
 * 指令强调「只输出替换文本」：编辑器场景里任何解释、前缀、引用都会污染正文。
 */
export const AI_ACTIONS: AiActionDef[] = [
  {
    id: 'polish',
    labelKey: 'ai.actions.polish',
    instruction:
      'Polish the selected text: improve wording, grammar and rhythm while keeping the original meaning, tone and language. Keep Markdown formatting.',
  },
  {
    id: 'rewrite',
    labelKey: 'ai.actions.rewrite',
    instruction:
      'Rewrite the selected text to be clearer and more natural, keeping the same meaning and language. Keep Markdown formatting.',
  },
  {
    id: 'shorten',
    labelKey: 'ai.actions.shorten',
    instruction:
      'Make the selected text more concise: remove redundancy and filler while preserving all key information and language.',
  },
  {
    id: 'expand',
    labelKey: 'ai.actions.expand',
    instruction:
      'Expand the selected text with relevant detail, examples or explanation in the same language and tone. Keep it cohesive with the original.',
  },
  {
    id: 'translate',
    labelKey: 'ai.actions.translate',
    instruction:
      'Translate the selected text. Keep Markdown formatting, do not add commentary, do not transliterate proper nouns unnecessarily.',
  },
  {
    id: 'proofread',
    labelKey: 'ai.actions.proofread',
    instruction:
      'Proofread the selected text: fix typos, grammar, punctuation and spacing errors. Do not change wording that is already correct.',
  },
  {
    id: 'normalize',
    labelKey: 'ai.actions.normalize',
    instruction:
      'Normalize the selected text as clean Markdown: consistent headings, list markers, spacing, emphasis and code fences. Keep the content unchanged.',
  },
]

/** 单次动作请求里允许发送的最大字符数：超出提示用户缩小选区，避免误发整篇 */
export const MAX_SELECTION_CHARS = 12_000

/** 捕获到的选区快照（范围取自触发时，用于结果回填与一致性校验） */
export interface CapturedSelection {
  from: number
  to: number
  text: string
}

/** 系统提示词：约束输出形态，避免模型解释、寒暄或包裹代码块 */
const SYSTEM_PROMPT = [
  'You are an editing assistant embedded in a Markdown editor.',
  'Return ONLY the replacement text for the user selection.',
  'Do not wrap the answer in code fences, do not add explanations, labels or quotes.',
  'Preserve the original Markdown structure and inline formatting unless the instruction says otherwise.',
].join(' ')

/**
 * 捕获当前选区。
 *
 * 空选区（光标）返回 null：行内动作必须作用在一段明确的文本上，
 * 否则模型无从判断替换范围。
 * @param view - 目标编辑器视图（缺省取当前 PM 视图）
 * @returns 选区快照；无选区或内容为空时返回 null
 */
export function captureSelection(view: EditorView | null = getPmView()): CapturedSelection | null {
  if (!view) return null
  const { from, to, empty } = view.state.selection
  if (empty) return null
  const text = view.state.doc.textBetween(from, to, '\n', '\n')
  if (!text.trim()) return null
  return { from, to, text }
}

/**
 * 判断文本主要语种，用于「翻译」自动选择目标语言。
 * 只区分中日韩字符与拉丁字母，足够覆盖编辑器里的常见场景。
 * 中英混排（如「这个 API 返回 JSON 数据」）按汉字占比判断：汉字数达到
 * 拉丁字母的一半即视为中文为主，避免把夹杂英文术语的中文「译成中文」。
 * @param text - 待判断文本
 * @returns 'cjk' 表示中日韩为主，'latin' 表示拉丁字母为主
 */
export function detectScript(text: string): 'cjk' | 'latin' {
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0
  return cjk * 2 >= latin ? 'cjk' : 'latin'
}

/**
 * 为「翻译」补充明确的目标语言：中文内容译成英文，其他内容译成简体中文。
 * 不写死「英文」是避免把日文/韩文内容也译成英文。
 * @param text - 选区文本
 * @param locale - 界面语言（zh-CN / zh-Hant / en）
 * @returns 追加了目标语言要求的系统提示词
 */
export function translationTarget(text: string, locale: string): string {
  if (detectScript(text) === 'latin') return 'Target language: Simplified Chinese (简体中文).'
  // locale 形如 en / en-US：前缀匹配，避免 en-US 界面走不进英文分支
  return locale.startsWith('en')
    ? 'Target language: English.'
    : 'Target language: English (keep any code, URLs and product names as-is).'
}

/**
 * 构造一次动作请求的消息列表。
 * @param actionId - 动作标识
 * @param text - 选区文本
 * @param locale - 界面语言（仅翻译动作用于推断目标语种）
 * @returns 系统提示词 + 用户内容
 */
export function buildActionMessages(
  actionId: AiActionId,
  text: string,
  locale: string,
): AiChatMessage[] {
  const action = AI_ACTIONS.find((item) => item.id === actionId)
  if (!action) throw new Error(`unknown ai action: ${actionId}`)
  const parts = [SYSTEM_PROMPT, action.instruction]
  if (actionId === 'translate') parts.push(translationTarget(text, locale))
  return [
    { role: 'system', content: parts.join('\n\n') },
    { role: 'user', content: text },
  ]
}

/**
 * 清洗模型输出：去掉偶发的整段代码围栏与首尾空白。
 *
 * 提示词已要求不要包裹代码块，但多数模型在长文本上仍会加 ```markdown 围栏；
 * 直接落库会把整段正文变成代码块，因此这里兜底剥离一层围栏。
 * @param raw - 模型原始输出
 * @returns 可直接写入文档的 Markdown 文本
 */
export function normalizeAiOutput(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced) return fenced[1].trim()
  return text
}

/**
 * 校验触发时的选区范围内的文本是否仍然是原来的内容。
 *
 * 流式期间用户可能继续编辑，直接按旧坐标替换会覆盖无关内容。
 * @param view - 编辑器视图
 * @param selection - 触发时捕获的选区
 * @returns 范围仍有效且内容一致时返回 true
 */
export function isSelectionIntact(view: EditorView | null, selection: CapturedSelection): boolean {
  if (!view) return false
  const { from, to } = selection
  if (from < 0 || to > view.state.doc.content.size || from >= to) return false
  return view.state.doc.textBetween(from, to, '\n', '\n') === selection.text
}

/** ProseMirror 文档的最小结构（单测用假对象即可满足） */
interface PmDocLike {
  content: { size: number }
  textBetween(from: number, to: number, blockSeparator?: string, leafText?: string | null): string
}

/** ProseMirror 事务映射的最小结构 */
interface PmMappingLike {
  map(pos: number, assoc?: number): number
}

/**
 * 把触发时捕获的选区按流式期间累积的事务映射到当前文档坐标。
 *
 * 选区外的编辑（在前面插入/删除段落）只平移坐标，映射后仍可安全替换；
 * 选区内的编辑会改变映射范围内的文本，返回 null 由调用方拒绝。
 * assoc 取向：from 跟随后侧内容（from, 1）、to 跟随前侧内容（to, -1），
 * 恰好落在边界上的插入不扩大替换范围。
 * @param doc - 当前文档
 * @param mapping - 自触发起累积的事务映射（每次 tr.mapping 依次复合）
 * @param selection - 触发时捕获的选区
 * @returns 映射后的选区；范围失效或文本已变时返回 null
 */
export function remapSelectionRange(
  doc: PmDocLike,
  mapping: PmMappingLike,
  selection: CapturedSelection,
): CapturedSelection | null {
  const from = mapping.map(selection.from, 1)
  const to = mapping.map(selection.to, -1)
  if (from < 0 || to > doc.content.size || from >= to) return null
  if (doc.textBetween(from, to, '\n', '\n') !== selection.text) return null
  return { from, to, text: selection.text }
}

/**
 * 把结果写回文档。
 *
 * 先校验范围处的文本仍是触发时选中的内容：流式期间用户可能继续编辑，
 * 直接按旧坐标替换会覆盖无关内容。不一致时返回 false，由界面提示重新选择。
 * @param selection - 触发时捕获的选区快照
 * @param markdown - 模型输出（内部会先做清洗）
 * @param view - 编辑器视图（缺省取当前 PM 视图）
 * @returns 是否成功替换
 */
export function applyAiResult(
  selection: CapturedSelection,
  markdown: string,
  view: EditorView | null = getPmView(),
): boolean {
  if (!isSelectionIntact(view, selection)) return false
  const cleaned = normalizeAiOutput(markdown)
  if (!cleaned) return false
  return applyMarkdownRange(selection.from, selection.to, cleaned)
}
