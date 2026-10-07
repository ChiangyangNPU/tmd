/**
 * 局部图谱侧边栏面板：当前笔记的邻域视图（对齐 Obsidian Local Graph）。
 *
 * 数据：
 * - 一跳出链：实时解析 currentMarkdown() 中的 [[..]]（带围栏跳过的行状态
 *   机）——未保存的新链接即时可见；目标经 resolveWikiTarget 解析，命中为
 *   真实节点、未命中为幽灵节点；
 * - 反链：双链索引（wikilink-index）中解析命中当前笔记的来源文档；
 * - 二跳（面板内可切 1/2 层）：一跳邻居按索引再扩展一层，去重；
 * - 当前笔记自身为中心节点（accent 色放大），不出现在邻居集合中。
 *
 * 渲染：侧边栏小 canvas + d3-force 迷你模拟（动态 import 懒加载，与全库
 * 图谱共享同一 chunk），每帧自动缩放适配节点包围盒（无需手动缩放平移）。
 * 悬停放大节点；点击节点跳转（幽灵节点 toast 提示）。刷新时机 = 面板打开
 * / 活动标签切换（1.5s 轮询路径变化）/ 双链索引刷新。
 *
 * @author chiangyang
 */
import type { Simulation, SimulationNodeDatum } from 'd3-force'
import { t } from './i18n'
import { openPath, showToast } from './files'
import { activeTab } from './tabs'
import { currentMarkdown } from './editor-core'
import { getWikiLinks, onWikiIndexRefreshed, resolveWikiTarget } from './wikilink-index'
import type { WikiResolution } from './wikilink'
import type { WikiLinkRef } from './native'

interface MiniNode extends SimulationNodeDatum {
  id: string
  label: string
  /** 当前笔记中心节点 */
  center?: boolean
  /** 未解析幽灵节点 */
  ghost?: boolean
}

interface MiniEdge {
  source: MiniNode | string
  target: MiniNode | string
}

/** 行内 wikilink 匹配（与 electron/wikilinks.cjs 同款正则） */
const WIKI_LINE_RE = /\[\[([^[\\\]\n]+)\]\]/g

/** [[..]] 内部 target 段（与 src/wikilink.ts 同构） */
function targetOf(inner: string): string {
  const pipe = inner.indexOf('|')
  const main = pipe === -1 ? inner : inner.slice(0, pipe)
  const hash = main.indexOf('#')
  return (hash === -1 ? main : main.slice(0, hash)).trim()
}

/**
 * 从 markdown 全文解析出链 target 列表（围栏代码块内跳过）。
 * 纯函数，导出供单测。
 */
export function parseOutTargets(md: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const text of md.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(text)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!fence) fence = ch
      else if (ch === fence) fence = null
      continue
    }
    if (fence) continue
    for (const m of text.matchAll(WIKI_LINE_RE)) {
      const target = targetOf(m[1])
      if (target && !out.includes(target)) out.push(target)
    }
  }
  return out
}

/**
 * 邻域收集（纯函数，导出供单测）：从当前笔记出发按深度扩展邻居。
 * links 为双链索引的解析边；liveOut 为实时解析的出链目标（target + 解析
 * 结果）。返回节点表（id → 信息）与去重后的边列表；当前笔记自身不在邻居
 * 集合中，幽灵节点以 `ghost:目标` 为 id。
 */
export function collectNeighborhood(
  currentPath: string,
  links: WikiLinkRef[],
  liveOut: Array<{ target: string; resolved: WikiResolution }>,
  depth: 1 | 2,
): {
  nodes: Map<string, { id: string; label: string; ghost: boolean }>
  edges: Array<[string, string]>
} {
  // 邻接表（无向）：id → 邻居列表（真实节点与幽灵节点混合）。
  // 只建表不收集——节点与边由下方 BFS 按深度收录，深度外的内容不进图。
  const adjacency = new Map<string, Array<{ id: string; label: string; ghost: boolean }>>()
  const neighborsOf = (id: string): Array<{ id: string; label: string; ghost: boolean }> => {
    const list = adjacency.get(id)
    if (list) return list
    const created: Array<{ id: string; label: string; ghost: boolean }> = []
    adjacency.set(id, created)
    return created
  }

  for (const l of links) {
    const from = l.source
    const fromLabel = baseName(from)
    neighborsOf(from)
    if (l.resolved.kind === 'ok') {
      const to = l.resolved.path
      if (to === from) continue
      neighborsOf(to)
      neighborsOf(from).push({ id: to, label: baseName(to), ghost: false })
      neighborsOf(to).push({ id: from, label: fromLabel, ghost: false })
      continue
    }
    const target = l.target.trim()
    if (!target) continue
    neighborsOf(from).push({ id: `ghost:${target}`, label: target, ghost: true })
    neighborsOf(`ghost:${target}`).push({ id: from, label: fromLabel, ghost: false })
  }
  // 实时出链（可能尚未入索引）：命中真实笔记则连真实节点，未命中为幽灵节点
  const curList = neighborsOf(currentPath)
  for (const out of liveOut) {
    if (out.resolved.kind === 'ok') {
      const to = out.resolved.path
      if (to === currentPath) continue
      neighborsOf(to)
      curList.push({ id: to, label: baseName(to), ghost: false })
      neighborsOf(to).push({ id: currentPath, label: baseName(currentPath), ghost: false })
      continue
    }
    if (!out.target.trim()) continue
    const ghostId = `ghost:${out.target.trim()}`
    curList.push({ id: ghostId, label: out.target.trim(), ghost: true })
    neighborsOf(ghostId).push({ id: currentPath, label: baseName(currentPath), ghost: false })
  }

  // 从当前笔记 BFS 按深度收录节点与边
  const nodes = new Map<string, { id: string; label: string; ghost: boolean }>()
  const edges: Array<[string, string]> = []
  const seenEdges = new Set<string>()
  const visited = new Set<string>([currentPath])
  nodes.set(currentPath, { id: currentPath, label: baseName(currentPath), ghost: false })
  let frontier = [currentPath]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adjacency.get(id) ?? []) {
        addNode(nodes, nb.id, nb.label, nb.ghost)
        const key = id < nb.id ? `${id}\u0000${nb.id}` : `${nb.id}\u0000${id}`
        if (!seenEdges.has(key)) {
          seenEdges.add(key)
          edges.push([id, nb.id])
        }
        if (!visited.has(nb.id)) {
          visited.add(nb.id)
          next.push(nb.id)
        }
      }
    }
    frontier = next
  }
  // 中心节点不计入邻居集合（返回前移除）
  nodes.delete(currentPath)
  return { nodes, edges }
}

/** 邻居集合收录（跳过已有） */
function addNode(
  nodes: Map<string, { id: string; label: string; ghost: boolean }>,
  id: string,
  label: string,
  ghost: boolean,
): void {
  if (!nodes.has(id)) nodes.set(id, { id, label, ghost })
}

function baseName(p: string): string {
  const norm = p.replaceAll('\\', '/')
  return norm.slice(norm.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}

// ---------------------------------------------------------------------------
// 面板状态与渲染
// ---------------------------------------------------------------------------

interface MiniGraphState {
  sim: Simulation<MiniNode, MiniEdge>
  nodes: MiniNode[]
  edges: MiniEdge[]
  /** 最近一帧的自动适配变换（鼠标命中测试与绘制同变换） */
  view: { k: number; tx: number; ty: number }
}

let state: MiniGraphState | null = null
let raf = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let lastActivePath: string | null = null
let depth: 1 | 2 = 1
let refreshSeq = 0

function isOpen(): boolean {
  const panel = document.getElementById('relations-panel')
  return !!panel && !panel.hidden
}

function setStatus(text: string): void {
  const el = document.getElementById('localgraph-status')
  if (el) el.textContent = text
}

/** 关闭面板并停止模拟（面板互斥：关闭后整个侧边栏一并收起） */
export function closeLocalGraph(): void {
  const panel = document.getElementById('relations-panel')
  if (panel) panel.setAttribute('hidden', '')
  document.getElementById('sidebar')?.setAttribute('hidden', '')
  state?.sim.stop()
  state = null
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  clearInterval(pollTimer)
}

/** 打开面板并渲染 */
export async function openLocalGraph(): Promise<void> {
  const panel = document.getElementById('relations-panel')
  if (!panel) return
  panel.hidden = false
  await refreshLocalGraph()
}

/** 重算当前笔记邻域并重启迷你模拟 */
export async function refreshLocalGraph(): Promise<void> {
  const panel = document.getElementById('relations-panel')
  const canvas = document.getElementById('localgraph-canvas') as HTMLCanvasElement | null
  if (!panel || panel.hidden || !canvas) return
  const seq = ++refreshSeq

  const tab = activeTab()
  if (!tab?.path) {
    setStatus(t('localGraph.untitled'))
    state?.sim.stop()
    state = null
    clearCanvas(canvas)
    return
  }
  setStatus(t('localGraph.loading'))
  const scan = await getWikiLinks()
  if (seq !== refreshSeq || !isOpen()) return
  const currentPath = tab.path

  // 一跳出链：实时解析当前文档（未保存的新链接即时可见）
  const liveOut = parseOutTargets(currentMarkdown())
    .filter((target) => target !== baseName(currentPath))
    .map((target) => ({ target, resolved: resolveWikiTarget(target, currentPath) }))
  const { nodes: neighborNodes, edges: neighborEdges } = collectNeighborhood(
    currentPath,
    scan?.links ?? [],
    liveOut,
    depth,
  )

  lastActivePath = currentPath
  if (neighborNodes.size === 0) {
    setStatus(t('localGraph.empty'))
    state?.sim.stop()
    state = null
    clearCanvas(canvas)
    return
  }
  setStatus(t('localGraph.summary', { count: neighborNodes.size }))

  const d3 = await import('d3-force')
  if (seq !== refreshSeq || !isOpen()) return

  const width = canvas.clientWidth || 240
  const height = canvas.clientHeight || 260
  const center: MiniNode = {
    id: currentPath,
    label: baseName(currentPath),
    center: true,
    x: width / 2,
    y: height / 2,
    fx: width / 2,
    fy: height / 2,
  }
  const miniNodes: MiniNode[] = [center]
  for (const [id, info] of neighborNodes) {
    const angle = Math.random() * Math.PI * 2
    miniNodes.push({
      id,
      label: info.label,
      ghost: info.ghost,
      x: width / 2 + Math.cos(angle) * 60,
      y: height / 2 + Math.sin(angle) * 60,
    })
  }
  const byId = new Map(miniNodes.map((n) => [n.id, n]))
  const miniEdges: MiniEdge[] = neighborEdges.map(([from, to]) => ({
    source: byId.get(from) ?? from,
    target: byId.get(to) ?? to,
  }))

  state?.sim.stop()
  const linkForce = d3
    .forceLink<MiniNode, MiniEdge>(miniEdges)
    .id((n) => n.id)
    .distance(40)
    .strength(0.7)
  const chargeForce = d3.forceManyBody<MiniNode>().strength(-60)
  const centerForce = d3.forceCenter(width / 2, height / 2)
  const sim: Simulation<MiniNode, MiniEdge> = d3
    .forceSimulation<MiniNode>(miniNodes)
    .force('link', linkForce)
    .force('charge', chargeForce)
    .force('center', centerForce)
  sim.alpha(1)
  state = { sim, nodes: miniNodes, edges: miniEdges, view: { k: 1, tx: 0, ty: 0 } }

  const drawLoop = () => {
    if (!state || !isOpen()) return
    draw(canvas, state)
    raf = requestAnimationFrame(drawLoop)
  }
  cancelAnimationFrame(raf)
  drawLoop()
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  const g = canvas.getContext('2d')
  if (!g) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round((canvas.clientWidth || 240) * dpr)
  canvas.height = Math.round((canvas.clientHeight || 260) * dpr)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, canvas.width, canvas.height)
}

/** 绘制一帧：自动缩放适配节点包围盒 → 边 → 节点 + 标签（全部显示） */
function draw(canvas: HTMLCanvasElement, st: MiniGraphState): void {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth || 240
  const height = canvas.clientHeight || 260
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, canvas.width, canvas.height)

  const css = getComputedStyle(document.documentElement)
  const fg = css.getPropertyValue('--fg').trim() || '#24292f'
  const accent = css.getPropertyValue('--accent').trim() || '#4a7cd4'
  const muted = css.getPropertyValue('--muted').trim() || '#6a737d'
  const border = css.getPropertyValue('--border').trim() || '#e2e6ea'

  // 自动缩放适配节点包围盒（含标签余量）
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of st.nodes) {
    minX = Math.min(minX, n.x ?? 0)
    maxX = Math.max(maxX, n.x ?? 0)
    minY = Math.min(minY, n.y ?? 0)
    maxY = Math.max(maxY, n.y ?? 0)
  }
  const pad = 34
  const bw = Math.max(maxX - minX, 1)
  const bh = Math.max(maxY - minY, 1)
  const k = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh, 2)
  const tx = width / 2 - ((minX + maxX) / 2) * k
  const ty = height / 2 - ((minY + maxY) / 2) * k
  st.view = { k, tx, ty }

  g.save()
  g.translate(tx, ty)
  g.scale(k, k)

  for (const e of st.edges) {
    const s = e.source as MiniNode
    const d = e.target as MiniNode
    const sx = s.x
    const sy = s.y
    const dx = d.x
    const dy = d.y
    if (sx == null || sy == null || dx == null || dy == null) continue
    g.strokeStyle = border
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(sx, sy)
    g.lineTo(dx, dy)
    g.stroke()
  }
  for (const n of st.nodes) {
    if (n.x == null || n.y == null) continue
    const radius = n.center ? 7 : n.ghost ? 4 : 5.5
    if (n.ghost) {
      g.strokeStyle = muted
      g.setLineDash([3, 3])
      g.lineWidth = 1.2
      g.beginPath()
      g.arc(n.x, n.y, radius, 0, Math.PI * 2)
      g.stroke()
      g.setLineDash([])
    } else {
      g.fillStyle = n.center ? accent : fg
      g.beginPath()
      g.arc(n.x, n.y, radius, 0, Math.PI * 2)
      g.fill()
    }
    g.fillStyle = n.center ? accent : n.ghost ? muted : fg
    g.font = `${n.center ? 'bold ' : ''}10px -apple-system, BlinkMacSystemFont, sans-serif`
    g.fillText(n.label, n.x + radius + 3, n.y + 3.5)
  }
  g.restore()
}

// ---------------------------------------------------------------------------
// 面板事件装配与刷新调度
// ---------------------------------------------------------------------------

/** 面板事件装配（boot 调用一次） */
export function wireLocalGraph(): void {
  const panel = document.getElementById('relations-panel')
  const canvas = document.getElementById('localgraph-canvas') as HTMLCanvasElement | null
  if (!panel || !canvas) return

  // 层数切换（1/2 层，持久化到轻量键）
  const applyDepth = (d: 1 | 2) => {
    depth = d
    localStorage.setItem('tmd:localgraph-depth', String(d))
    for (const btn of panel.querySelectorAll<HTMLButtonElement>('[data-depth]')) {
      btn.classList.toggle('active', Number(btn.dataset.depth) === d)
    }
    void refreshLocalGraph()
  }
  panel.querySelectorAll<HTMLButtonElement>('[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => applyDepth(Number(btn.dataset.depth) as 1 | 2))
  })
  depth = localStorage.getItem('tmd:localgraph-depth') === '2' ? 2 : 1
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('[data-depth]')) {
    btn.classList.toggle('active', Number(btn.dataset.depth) === depth)
  }

  // 面板头部 ✕ 为显式出口（关闭时整个侧边栏一并收起）
  document
    .getElementById('localgraph-close-btn')
    ?.addEventListener('click', () => closeLocalGraph())

  // 画布交互：悬停放大节点 / 点击跳转（命中测试与绘制共用自动适配变换）
  const hit = (e: MouseEvent): MiniNode | null => {
    if (!state) return null
    const rect = canvas.getBoundingClientRect()
    const gx = (e.clientX - rect.left - state.view.tx) / state.view.k
    const gy = (e.clientY - rect.top - state.view.ty) / state.view.k
    let best: MiniNode | null = null
    let bestDist = 12 / state.view.k
    for (const n of state.nodes) {
      if (n.x == null || n.y == null) continue
      const radius = n.center ? 7 : n.ghost ? 4 : 5.5
      const dist = Math.hypot(n.x - gx, n.y - gy)
      if (dist <= radius + 6 / state.view.k && dist < bestDist) {
        best = n
        bestDist = dist
      }
    }
    return best
  }
  canvas.addEventListener('mousemove', (e) => {
    const node = hit(e)
    canvas.style.cursor = node ? 'pointer' : 'default'
  })
  canvas.addEventListener('click', (e) => {
    const node = hit(e)
    if (!node) return
    if (node.ghost) {
      showToast(t('wikilink.notFound', { target: node.label }))
      return
    }
    if (node.id !== (activeTab()?.path ?? '')) void openPath(node.id)
  })

  // 刷新：索引刷新（保存/改名触发）+ 活动标签路径变化轮询（仅面板可见时）
  onWikiIndexRefreshed(() => {
    if (isOpen()) void refreshLocalGraph()
  })
  pollTimer = setInterval(() => {
    if (!isOpen()) return
    const p = activeTab()?.path ?? null
    if (p !== lastActivePath) void refreshLocalGraph()
  }, 1500)
}

/** 活动标签或索引变化时的轻量刷新入口（main.ts 变更钩子调用） */
export function notifyLocalGraphDocChanged(): void {
  if (isOpen()) void refreshLocalGraph()
}
