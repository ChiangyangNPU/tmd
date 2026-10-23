/**
 * AI 选区气泡：选中文本后浮出动作按钮 → 流式预览 → 用户确认后一次性替换。
 *
 * 交互约束（与项目既有浮层一致）：
 * - 气泡只跟随 ProseMirror 选区，源码模式天然不出现（没有 PM 插件实例）
 * - 流式结果只进预览区，不写编辑器；只有「接受」才派发一次替换事务
 * - 任何阶段都可取消；切换选区 / 失去焦点 / Esc 不会中断在途请求，
 *   而是明确取消请求，避免结果落到错误位置
 * - 气泡本身不抢焦点（不设 tabindex），点按钮不会让编辑器选区丢失
 *
 * @author chiangyang
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import type { EditorView } from '@milkdown/kit/prose/view'
import { t } from './i18n'
import { showToast } from './files'
import { aiErrorMessage, chatAi, isAiEnabled, refreshAiEnabled } from './ai'
import type { AiChatSession } from './ai'
import {
  AI_ACTIONS,
  MAX_SELECTION_CHARS,
  applyAiResult,
  buildActionMessages,
  captureSelection,
  normalizeAiOutput,
  remapSelectionRange,
} from './ai-actions'
import type { AiActionId, CapturedSelection } from './ai-actions'

/** 气泡与选区/视口边缘的最小间距（像素） */
const GAP = 8

/** 气泡的最大宽度（流式长文本换行不撑破版面） */
const MAX_WIDTH = 460

/** 气泡阶段：idle 只显示动作按钮；其余阶段显示流式结果 */
type Phase = 'idle' | 'streaming' | 'done' | 'error'

/** 当前可用的 PM 视图（由插件 update 更新；命令面板 / 快捷键据此取选区） */
let currentView: EditorView | null = null
/** 本次动作的选区快照：结果回填的目标范围 */
let captured: CapturedSelection | null = null
/** 在途请求句柄（取消用） */
let session: AiChatSession | null = null
/** 最近一次动作（重新生成用） */
let lastAction: AiActionId | null = null
/** 流式累积的原始输出 */
let output = ''
/** 流式累积的思考过程（推理模型先输出 reasoning_content） */
let reasoning = ''
/** 当前阶段 */
let phase: Phase = 'idle'
/** 是否已装配（boot 只调用一次） */
let wired = false
/**
 * 请求代次：每次发起动作 / 重置时自增。
 * 被取消的请求仍可能在主进程回推 error(cancelled)，回调据此判断自己是否已过期，
 * 避免过期事件把气泡重新置为 error 阶段、卡住空闲态的自动浮出。
 */
let requestToken = 0

/** 取气泡内的元素（不存在时返回 null，便于浏览器环境降级） */
function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/**
 * 在途选区的插件状态：随每次事务把捕获选区映射到最新文档坐标。
 *
 * 映射成功（选区外编辑只平移坐标）时接受可按新落点替换；选区内被编辑
 * （映射后文本不一致）时置 null，接受按旧坐标校验必然失败、提示重新选择。
 */
const capturedRangeKey = new PluginKey<CapturedSelection | null>('tmd-ai-captured-range')

/** 读当前映射后的在途选区（无插件状态 / 已失效时返回 null） */
function mappedSelection(view: EditorView | null): CapturedSelection | null {
  if (!view) return null
  try {
    return capturedRangeKey.getState(view.state) ?? null
  } catch {
    return null
  }
}

/** 气泡应锚定的文档坐标：优先取映射后的最新位置，退回捕获值 */
function anchorPos(view: EditorView): number {
  return mappedSelection(view)?.from ?? captured?.from ?? 0
}

/** 显示/隐藏动作按钮区与结果区 */
function renderPhase() {
  const actions = el('ai-action-list')
  const result = el('ai-result-area')
  if (actions) actions.hidden = phase !== 'idle'
  if (result) result.hidden = phase === 'idle'
  const accept = el<HTMLButtonElement>('ai-accept-btn')
  if (accept) accept.disabled = phase !== 'done' || !output.trim()
}

/** 更新结果区状态文案（发送范围 / 错误信息 / 空） */
function setStatus(text: string) {
  const status = el('ai-status-text')
  if (status) status.textContent = text
}

/** 更新流式预览文本 */
function renderOutput() {
  const box = el('ai-output')
  if (box) box.textContent = output
}

/** 更新思考过程预览（首个增量到达时才显示区块） */
function renderReasoning() {
  const area = el('ai-reasoning-area')
  const box = el('ai-reasoning')
  if (!area || !box) return
  if (!reasoning) {
    area.hidden = true
    box.textContent = ''
    return
  }
  area.hidden = false
  box.textContent = reasoning
  // 限高内滚：流式期间保持在底部，最新内容始终可见
  box.scrollTop = box.scrollHeight
}

/** 关闭气泡（不清理由调用方设置的状态时由 reset 负责） */
function hideBubble() {
  const bubble = el('ai-bubble')
  if (bubble) bubble.hidden = true
}

/**
 * 重置到可再次触发的空闲态。
 *
 * 在途请求必须在这里统一取消：openAiBubble 等入口只重置状态而不关气泡，
 * 若不取消，旧请求会在后台继续消耗 token，且其迟到事件只能靠代次丢弃。
 * 对已完成的请求 cancel 是无害空操作（abort 未命中即直接清理）。
 */
function reset() {
  requestToken++
  session?.cancel()
  session = null
  captured = null
  lastAction = null
  output = ''
  reasoning = ''
  phase = 'idle'
  renderOutput()
  renderReasoning()
  setStatus('')
  renderPhase()
}

/** 取消在途请求并关闭气泡 */
export function closeAiBubble() {
  hideBubble()
  reset()
}

/**
 * 定位气泡：优先放在选区上方，空间不足则放到下方，水平方向夹在视口内。
 * @param view - 编辑器视图
 * @param from - 选区起点（文档坐标）
 */
function positionBubble(view: EditorView, from: number) {
  const bubble = el('ai-bubble')
  if (!bubble) return
  const coords = view.coordsAtPos(from)
  bubble.hidden = false
  bubble.style.width = `${Math.min(MAX_WIDTH, window.innerWidth - GAP * 2)}px`
  const rect = bubble.getBoundingClientRect()
  let left = coords.left
  if (left + rect.width > window.innerWidth - GAP) {
    left = window.innerWidth - rect.width - GAP
  }
  let top = coords.top - rect.height - GAP
  if (top < GAP) top = coords.bottom + GAP
  bubble.style.left = `${Math.max(GAP, left)}px`
  bubble.style.top = `${Math.max(GAP, top)}px`
}

/**
 * 按当前选区同步气泡显隐与位置。
 *
 * 在途请求期间保持显示（即使选区折叠），否则用户失去取消入口、结果也无处确认；
 * 用户主动收起（Esc / 关闭按钮）时由 closeAiBubble 负责取消请求。
 */
function syncBubble() {
  const view = currentView
  if (!isAiEnabled() || !view || !view.editable) {
    if (phase === 'idle') hideBubble()
    return
  }
  if (phase !== 'idle') {
    if (captured) positionBubble(view, anchorPos(view))
    return
  }
  const selection = captureSelection(view)
  if (!selection) {
    hideBubble()
    return
  }
  positionBubble(view, selection.from)
}

/**
 * 启动一次动作：捕获选区 → 立即发送 → 流式渲染到预览区。
 * 无选区或超出字数上限时提示并返回，不发起网络请求。
 * @param actionId - 动作标识
 */
export function startAiAction(actionId: AiActionId): void {
  const view = currentView
  if (!isAiEnabled()) {
    showToast(t('ai.error.disabled'))
    return
  }
  const selection = captureSelection(view)
  if (!selection) {
    showToast(t('ai.noSelection'))
    return
  }
  if (selection.text.length > MAX_SELECTION_CHARS) {
    showToast(t('ai.selectionTooLong', { max: MAX_SELECTION_CHARS }))
    return
  }
  // 前一次请求仍在途：先取消，避免两份结果交错渲染
  session?.cancel()
  // 代次自增：此前的回调即便稍后到达也不再生效
  const token = ++requestToken
  captured = selection
  lastAction = actionId
  output = ''
  reasoning = ''
  phase = 'streaming'
  renderOutput()
  renderReasoning()
  renderPhase()
  setStatus(t('ai.sending', { chars: selection.text.length }))
  // 登记在途选区：此后每次事务都会把范围映射到最新坐标（接受时按映射落点校验）
  const wiredView = view as EditorView
  wiredView.dispatch(wiredView.state.tr.setMeta(capturedRangeKey, selection))
  positionBubble(wiredView, selection.from)

  const action = AI_ACTIONS.find((item) => item.id === actionId)
  if (action) {
    const title = el('ai-bubble-title')
    if (title) title.textContent = t(action.labelKey)
  }

  // 过期回调统一忽略：气泡已关闭 / 已发起新请求时，旧请求的增量与结束事件都不得改状态
  const stale = () => token !== requestToken

  session = chatAi(buildActionMessages(actionId, selection.text, navigator.language ?? 'zh-CN'), {
    onReasoning(text) {
      if (stale()) return
      reasoning += text
      renderReasoning()
    },
    onDelta(text) {
      if (stale()) return
      output += text
      renderOutput()
    },
    onDone() {
      if (stale()) return
      phase = 'done'
      output = normalizeAiOutput(output)
      renderOutput()
      renderPhase()
      setStatus('')
    },
    onError(error) {
      if (stale()) return
      phase = 'error'
      renderPhase()
      setStatus(aiErrorMessage(error.code, error.message))
    },
  })
}

/**
 * 从右键菜单等入口打开：有选区时直接显示动作按钮，不预先发送请求。
 * @returns 是否成功打开（无选区 / 未启用时返回 false）
 */
export function openAiBubble(): boolean {
  if (!isAiEnabled()) {
    showToast(t('ai.error.disabled'))
    return false
  }
  const view = currentView
  const selection = captureSelection(view)
  if (!selection || !view) {
    showToast(t('ai.noSelection'))
    return false
  }
  reset()
  hideBubble()
  phase = 'idle'
  renderPhase()
  const title = el('ai-bubble-title')
  if (title) title.textContent = t('ai.title')
  setStatus(t('ai.selectedChars', { chars: selection.text.length }))
  positionBubble(view, selection.from)
  // 记录选区由 startAiAction 重新捕获（期间用户可能调整选区，以最新为准）
  return true
}

/**
 * 读取配置刷新可用状态（boot 与设置保存后各调用一次）。
 * 关闭 AI 时收起气泡并中止在途请求：结果已无处落地，继续跑完只是
 * 把剩余 token 白白发给服务商。
 */
export async function refreshAiAvailability(): Promise<void> {
  const enabled = await refreshAiEnabled()
  if (!enabled) closeAiBubble()
}

/** 接受结果：按映射后的最新落点做单事务替换，文本已变时提示重新选择 */
function acceptResult() {
  if (!captured || !output.trim()) return
  const view = currentView
  // 流式期间的编辑只平移坐标时按新落点替换；选区内被编辑（映射为 null /
  // 落点文本不一致）时 applyAiResult 校验失败，提示重新选择
  const mapped = mappedSelection(view)
  const ok = applyAiResult(mapped ?? captured, output, view)
  if (!ok) {
    showToast(t('ai.selectionChanged'))
    return
  }
  hideBubble()
  reset()
  view?.focus()
}

/** 装配气泡：按钮事件、Esc 收起、滚动/缩放跟随（boot 调用一次） */
export function initAiBubble(): void {
  if (wired) return
  wired = true

  // 动作按钮由动作表生成，保证按钮顺序、文案与命令面板同源
  const list = el('ai-action-list')
  if (list) {
    list.textContent = ''
    for (const action of AI_ACTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ai-action-btn'
      btn.dataset.aiAction = action.id
      btn.textContent = t(action.labelKey)
      btn.addEventListener('click', () => startAiAction(action.id))
      list.appendChild(btn)
    }
  }

  el('ai-accept-btn')?.addEventListener('click', acceptResult)
  el('ai-retry-btn')?.addEventListener('click', () => {
    if (lastAction) startAiAction(lastAction)
  })
  el('ai-cancel-btn')?.addEventListener('click', closeAiBubble)
  el('ai-bubble-close')?.addEventListener('click', closeAiBubble)

  // Esc：只处理气泡可见时的按键，避免影响编辑器自身的 Esc 语义
  document.addEventListener('keydown', (event) => {
    const bubble = el('ai-bubble')
    if (event.key !== 'Escape' || !bubble || bubble.hidden) return
    event.stopPropagation()
    closeAiBubble()
  })

  // 滚动 / 缩放时跟随选区重新定位（与表格工具栏同一策略）
  window.addEventListener(
    'scroll',
    () => {
      if (phase === 'idle') syncBubble()
      else if (currentView && captured) positionBubble(currentView, anchorPos(currentView))
    },
    true,
  )
  window.addEventListener('resize', () => {
    if (currentView && captured) positionBubble(currentView, anchorPos(currentView))
    else if (phase === 'idle') syncBubble()
  })

  // 设置面板保存后由 settings.ts 广播，避免每帧读配置
  window.addEventListener('tmd:ai-config-changed', () => void refreshAiAvailability())
  void refreshAiAvailability()
}

/**
 * 气泡插件：随每次编辑器事务同步显隐与位置。
 * 只在所见即所得侧存在，源码模式/分屏只读侧不会浮出。
 */
class AiBubbleView {
  /** 最近一次传入的视图（编辑器重建时会被替换） */
  #view: EditorView

  /** @param view - 所属编辑器视图 */
  constructor(view: EditorView) {
    this.#view = view
  }

  /**
   * 每次事务后调用：更新视图引用并按选区同步气泡。
   * @param view - 当前编辑器视图
   */
  update(view: EditorView): void {
    this.#view = view
    currentView = view
    syncBubble()
  }

  /** 编辑器销毁：隐藏气泡，避免切标签/切源码模式后残留 */
  destroy(): void {
    if (currentView === this.#view) currentView = null
    hideBubble()
  }
}

/** 选区气泡插件（editor-core 装配用） */
export const aiBubblePlugin = $prose(
  () =>
    new Plugin({
      key: capturedRangeKey,
      state: {
        init: () => null,
        apply(tr, value) {
          // 显式登记（发起动作时）直接替换；否则把既有范围映射到本次事务后的坐标
          const set = tr.getMeta(capturedRangeKey)
          if (set !== undefined) return set
          if (!value) return null
          return remapSelectionRange(tr.doc, tr.mapping, value)
        },
      },
      view: (view) => new AiBubbleView(view),
    }),
)
