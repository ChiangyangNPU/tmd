/**
 * AI 问答面板（侧边栏）：多轮对话 + 上下文装配。
 *
 * 与选区气泡的分工：气泡是「选中即改写」的单轮编辑工具；本面板是「围绕
 * 文档提问」的多轮问答。按设置里的「发送上下文」装配三类上下文——选区 /
 * 当前文档 / 工作区检索片段——并在每次发送前于输入框上方明示实际发送
 * 范围（设置面板隐私承诺的落地）。
 *
 * 网络与 Key 仍在主进程（见 ai.ts / ai-retrieval.ts）；回答只以纯文本
 * 渲染（textContent，不走 innerHTML），思考过程与气泡同一套弱化样式。
 * 历史只保留最近的有限条数，且存的是「裸问题」——上下文块只附加在当前
 * 一轮，避免历史里反复堆积同一份文档内容。
 *
 * @author chiangyang
 */
import { t } from './i18n'
import type { AiChatMessage, AiConfigView } from './native'
import { aiErrorMessage, chatAi, fetchAiConfig, isAiAvailable, isAiEnabled } from './ai'
import type { AiChatSession } from './ai'
import { captureSelection } from './ai-actions'
import { retrieveWorkspaceContext } from './ai-retrieval'
import type { WorkspaceChunk } from './ai-retrieval'

/** 历史保留的最近消息条数（超出丢最旧） */
const HISTORY_MAX_MESSAGES = 12
/** 历史总字符上限 */
const HISTORY_MAX_CHARS = 60_000
/** 选区上下文字符上限 */
const SELECTION_MAX_CHARS = 4_000
/** 文档上下文字符上限 */
const DOCUMENT_MAX_CHARS = 12_000

const CHAT_SYSTEM_PROMPT = [
  'You are a writing assistant embedded in a Markdown editor.',
  'Answer in the same language as the user question. Use Markdown formatting.',
  'When editor context is provided (selection, current document, workspace excerpts), prefer it and cite the source file path when quoting it.',
  'If the context is insufficient or irrelevant, answer from general knowledge and say so.',
].join(' ')

/** 一次发送前捕获的上下文快照 */
export interface ChatContext {
  selection: string | null
  document: { name: string; content: string } | null
  workspace: WorkspaceChunk[]
}

/** XML 标签属性转义（文件路径会拼进 path="..."） */
function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
}

/**
 * 装配一次问答请求的消息列表（纯函数，便于单测）。
 * 上下文块只附加在当前问题上；历史里的用户消息是裸问题，不含旧上下文。
 * @param question - 本轮问题
 * @param ctx - 上下文快照
 * @param history - 既有对话（user / assistant 交替）
 */
export function buildChatMessages(
  question: string,
  ctx: ChatContext,
  history: AiChatMessage[],
): AiChatMessage[] {
  const parts: string[] = []
  if (ctx.selection) {
    parts.push(`<selected_text>\n${ctx.selection}\n</selected_text>`)
  }
  if (ctx.document) {
    parts.push(
      `<current_document path="${escapeAttr(ctx.document.name)}">\n${ctx.document.content}\n</current_document>`,
    )
  }
  if (ctx.workspace.length) {
    const excerpts = ctx.workspace
      .map((chunk) => `<excerpt path="${escapeAttr(chunk.path)}">\n${chunk.text}\n</excerpt>`)
      .join('\n')
    parts.push(`<workspace_excerpts>\n${excerpts}\n</workspace_excerpts>`)
  }
  const contextBlock = parts.length
    ? `Editor context (use if relevant, cite file paths when quoting):\n\n${parts.join('\n\n')}\n\n`
    : ''
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...capHistory(history),
    { role: 'user', content: `${contextBlock}${question}` },
  ]
}

/**
 * 历史截断：保留最近 N 条且总字符不超限（纯函数）。
 * @param history - 完整历史
 */
export function capHistory(history: AiChatMessage[]): AiChatMessage[] {
  const recent = history.slice(-HISTORY_MAX_MESSAGES)
  let total = 0
  for (const message of recent) total += message.content.length
  while (recent.length && total > HISTORY_MAX_CHARS) {
    total -= recent[0].content.length
    recent.shift()
  }
  return recent
}

// ---------------------------------------------------------------------------
// 面板状态
// ---------------------------------------------------------------------------

/** 对话历史（裸问题与回答，不含上下文块） */
let history: AiChatMessage[] = []
/** 在途请求句柄 */
let session: AiChatSession | null = null
/** 是否正在流式接收 */
let streaming = false
/** 最近一次配置视图（上下文开关 + 向量模型名） */
let configView: AiConfigView | null = null
/** 发送代次：清空对话后丢弃在途回调（与气泡 requestToken 同一做法） */
let sendToken = 0
/** 当前流式回答的输出累积（完成后入历史） */
let currentOutput = ''
/** 装配是否完成（boot 调用一次） */
let wired = false
/** 文档内容注入点（main.ts 装配，避免本模块依赖 tabs） */
let getDocument: () => { name: string; content: string } = () => ({ name: '', content: '' })

/** 取面板元素（不存在时返回 null，便于浏览器环境降级） */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/** 当前正在流式渲染的回答元素（null 表示面板无在途回答） */
let answerEl: HTMLElement | null = null
let reasoningAreaEl: HTMLElement | null = null
let reasoningEl: HTMLElement | null = null

/** 消息列表滚到底部（流式期间最新内容始终可见） */
function scrollMessages() {
  const list = el('ai-chat-messages')
  if (list) list.scrollTop = list.scrollHeight
}

/** 空态提示按消息数显隐（空态节点常驻列表内，便于随内容滚动） */
function refreshEmptyState() {
  const empty = el('ai-chat-empty')
  const list = listEl()
  if (empty) empty.hidden = !!list?.querySelector('.ai-chat-msg, .ai-chat-status')
}

/** 消息列表容器 */
function listEl(): HTMLElement | null {
  return el('ai-chat-messages')
}

/** 流式/空闲控件切换（发送 ↔ 停止；空输入同样禁用发送） */
function renderControls() {
  const send = el<HTMLButtonElement>('ai-chat-send-btn')
  const stop = el('ai-chat-stop-btn')
  const input = el<HTMLTextAreaElement>('ai-chat-input')
  if (send) send.disabled = streaming || !isAiEnabled() || !input?.value.trim()
  if (stop) stop.hidden = !streaming
}

/** 未启用提示行（浏览器环境与未启用是两种文案） */
function renderHint() {
  const hint = el('ai-chat-hint')
  if (!hint) return
  const enabled = isAiEnabled()
  hint.hidden = enabled
  if (!enabled) {
    hint.textContent = isAiAvailable() ? t('ai.chat.disabled') : t('ai.unavailable')
  }
  renderControls()
}

/** 新建一条消息气泡；kind 决定样式侧（user 右对齐强调，assistant 通栏） */
function appendMessageEl(kind: 'user' | 'assistant'): HTMLElement | null {
  const list = listEl()
  if (!list) return null
  const empty = el('ai-chat-empty')
  if (empty) empty.hidden = true
  const msg = document.createElement('div')
  msg.className = `ai-chat-msg ai-chat-${kind}`
  list.appendChild(msg)
  return msg
}

/** 发送前渲染上下文徽标（实际发送范围明示） */
function renderBadges(ctx: ChatContext, mode: 'embeddings' | 'keywords') {
  const badges = el('ai-chat-badges')
  if (!badges) return
  const parts: string[] = []
  if (ctx.selection) parts.push(t('ai.chat.ctxSelection', { chars: ctx.selection.length }))
  if (ctx.document) {
    parts.push(t('ai.chat.ctxDocument', { chars: ctx.document.content.length }))
  }
  if (ctx.workspace.length) {
    parts.push(
      t('ai.chat.ctxWorkspace', {
        count: ctx.workspace.length,
        mode: t(`ai.chat.mode_${mode}`),
      }),
    )
  }
  badges.hidden = !parts.length
  badges.textContent = parts.join(' · ')
}

/**
 * 按配置装配上下文快照。工作区检索可能读盘 + 嵌入，耗时较长，调用方
 * 需在 await 前给出「检索中」状态提示。
 * @param question - 用户问题（作为检索查询）
 */
async function gatherContext(question: string): Promise<ChatContext & { mode: 'embeddings' | 'keywords' }> {
  const context = configView?.context ?? { selection: true, document: false, workspace: false }
  let selection: string | null = null
  let doc: { name: string; content: string } | null = null
  let workspace: WorkspaceChunk[] = []
  let mode: 'embeddings' | 'keywords' = 'keywords'
  if (context.selection) {
    const captured = captureSelection()
    if (captured && captured.text.trim()) {
      selection = captured.text.slice(0, SELECTION_MAX_CHARS)
    }
  }
  if (context.document) {
    const { name, content } = getDocument()
    if (content.trim()) doc = { name, content: content.slice(0, DOCUMENT_MAX_CHARS) }
  }
  if (context.workspace) {
    const result = await retrieveWorkspaceContext(question, !!configView?.embedModel)
    workspace = result.chunks
    mode = result.mode
  }
  return { selection, document: doc, workspace, mode }
}

/**
 * 发送一条问题：装配上下文 → 渲染用户气泡与徽标 → 流式渲染回答。
 * 检索期间再次点击发送会被 streaming 状态挡住；清空对话会令代次过期，
 * 迟到的回调全部丢弃。
 */
async function sendMessage(): Promise<void> {
  if (streaming) return
  const input = el<HTMLTextAreaElement>('ai-chat-input')
  const question = input?.value.trim() ?? ''
  if (!question) return
  if (!isAiEnabled()) {
    renderHint()
    return
  }
  const token = ++sendToken
  // 置位提前到检索前：工作区检索可能读盘 + 嵌入数秒，期间必须挡住再次发送
  streaming = true
  renderControls()
  const busy = appendStatusLine(t('ai.chat.retrieving'))
  let ctx: Awaited<ReturnType<typeof gatherContext>>
  try {
    ctx = await gatherContext(question)
  } catch {
    busy.remove()
    if (token === sendToken) {
      // 检索意外失败：整轮放弃，恢复可输入状态
      streaming = false
      renderControls()
    }
    return
  }
  if (token !== sendToken) {
    // 清空对话已重置状态；此处的迟到结果直接丢弃
    busy.remove()
    return
  }
  busy.remove()

  // 用户气泡 + 徽标 + 空的回答气泡（流式增量填入）
  const userEl = appendMessageEl('user')
  if (userEl) userEl.textContent = question
  renderBadges(ctx, ctx.mode)
  currentOutput = ''
  const assistantEl = appendMessageEl('assistant')
  if (assistantEl) {
    reasoningAreaEl = document.createElement('div')
    reasoningAreaEl.className = 'ai-reasoning'
    reasoningAreaEl.hidden = true
    const label = document.createElement('span')
    label.className = 'ai-reasoning-label'
    label.textContent = t('ai.reasoning')
    reasoningEl = document.createElement('div')
    reasoningEl.className = 'ai-reasoning-text'
    reasoningAreaEl.append(label, reasoningEl)
    answerEl = document.createElement('div')
    answerEl.className = 'ai-chat-answer'
    assistantEl.append(reasoningAreaEl, answerEl)
  }
  if (input) input.value = ''
  streaming = true
  renderControls()
  scrollMessages()

  const stale = () => token !== sendToken
  session = chatAi(buildChatMessages(question, ctx, history), {
    onReasoning(text) {
      if (stale() || !reasoningAreaEl || !reasoningEl) return
      reasoningAreaEl.hidden = false
      reasoningEl.textContent += text
      reasoningEl.scrollTop = reasoningEl.scrollHeight
      scrollMessages()
    },
    onDelta(text) {
      if (stale() || !answerEl) return
      currentOutput += text
      answerEl.textContent = currentOutput
      scrollMessages()
    },
    onDone() {
      if (stale()) return
      // 完成才入历史（失败 / 取消的轮次不进，用户可直接重问）
      history.push({ role: 'user', content: question })
      history.push({ role: 'assistant', content: currentOutput })
      finishStreaming()
    },
    onError(error) {
      if (stale()) return
      if (answerEl) {
        // 主动停止保留已生成的部分；其余错误在气泡下方给出文案
        if (error.code === 'cancelled') {
          const note = document.createElement('div')
          note.className = 'ai-chat-note'
          note.textContent = t('ai.chat.stopped')
          answerEl.parentElement?.appendChild(note)
        } else {
          const note = document.createElement('div')
          note.className = 'ai-chat-error'
          note.textContent = aiErrorMessage(error.code, error.message)
          answerEl.parentElement?.appendChild(note)
        }
      }
      finishStreaming()
    },
  })
}

/** 结束流式态（done / error / cancelled 共用） */
function finishStreaming() {
  streaming = false
  session = null
  answerEl = null
  reasoningEl = null
  reasoningAreaEl = null
  renderControls()
  scrollMessages()
}

/** 在消息列表底部追加一条临时状态行（检索中等），返回可移除的节点 */
function appendStatusLine(text: string): HTMLElement {
  const list = listEl()
  const line = document.createElement('div')
  line.className = 'ai-chat-status'
  line.textContent = text
  list?.appendChild(line)
  scrollMessages()
  return line
}

/** 停止在途请求（保留已生成部分，回调经 cancelled 分支收尾） */
function stopStreaming() {
  session?.cancel()
}

/** 清空对话（在途请求一并取消，迟到回调按代次丢弃） */
function clearConversation() {
  sendToken++
  session?.cancel()
  session = null
  streaming = false
  history = []
  currentOutput = ''
  answerEl = null
  reasoningEl = null
  reasoningAreaEl = null
  const list = listEl()
  const empty = el('ai-chat-empty')
  if (list) {
    // 只清消息节点，保留空态提示（其文案由 i18n 在 boot 时写入，重建会丢）
    for (const child of [...list.children]) {
      if (child !== empty) child.remove()
    }
  }
  const badges = el('ai-chat-badges')
  if (badges) badges.hidden = true
  refreshEmptyState()
  renderControls()
}

/** 刷新配置缓存与未启用提示（boot 与设置保存广播后各一次） */
async function refreshChatConfig(): Promise<void> {
  if (!isAiAvailable()) return
  configView = await fetchAiConfig()
  renderHint()
}

/** 聚焦输入框（面板展开时调用） */
export function focusAiChatInput(): void {
  const input = el<HTMLTextAreaElement>('ai-chat-input')
  if (input && !streaming) input.focus()
}

/**
 * 装配问答面板（boot 调用一次）。
 * @param deps.getDocument - 取当前文档（名称 + Markdown 全文），由 main.ts 注入
 */
export function wireAiChat(deps: { getDocument: () => { name: string; content: string } }): void {
  getDocument = deps.getDocument
  if (wired) return
  wired = true

  const input = el<HTMLTextAreaElement>('ai-chat-input')
  if (input) {
    input.addEventListener('keydown', (e) => {
      // IME 组字期间的 Enter 用于候选词确认，不触发发送
      if (e.isComposing) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendMessage()
      }
    })
    input.addEventListener('input', () => {
      const send = el<HTMLButtonElement>('ai-chat-send-btn')
      if (send && !streaming) send.disabled = !input.value.trim() || !isAiEnabled()
    })
  }
  el('ai-chat-send-btn')?.addEventListener('click', () => void sendMessage())
  el('ai-chat-stop-btn')?.addEventListener('click', stopStreaming)
  el('ai-chat-clear-btn')?.addEventListener('click', clearConversation)
  // 面板头部 ✕ 为显式出口（与局部图谱一致：关闭时整个侧边栏一并收起）
  el('ai-chat-close-btn')?.addEventListener('click', () => {
    el('ai-panel')?.setAttribute('hidden', '')
    el('sidebar')?.setAttribute('hidden', '')
  })

  window.addEventListener('tmd:ai-config-changed', () => void refreshChatConfig())
  void refreshChatConfig()
  refreshEmptyState()
  renderControls()
}
