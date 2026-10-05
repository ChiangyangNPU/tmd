/**
 * 关系图谱面板：以力导向布局呈现工作区笔记的双链关系。
 *
 * 数据来自双链索引（wikilink-index 的按需扫描）：节点 = 笔记，
 * 边 = 解析命中的 [[..]]（同对笔记多条引用合并为一条，重复计数体现为
 * 线宽）。布局用 d3-force（动态 import 懒加载为独立 chunk，与
 * pinyin-pro 的懒加载策略一致），绘制用 canvas 2d。
 *
 * 交互：滚轮缩放 / 空白处拖拽平移 / 拖拽节点 / 悬停高亮邻居 / 点击节点
 * 打开笔记。颜色全部取主题 CSS 变量（每帧读取，深浅/预设切换即时跟随）。
 *
 * @author chiangyang
 */
import { t } from './i18n'
import { openPath } from './files'
import { getWikiLinks } from './wikilink-index'

interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
  degree: number
}

interface GraphEdge {
  source: GraphNode | string
  target: GraphNode | string
  weight: number
}

interface SimulationNodeDatum {
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
  vx?: number
  vy?: number
  index?: number
}

interface Simulation {
  nodes(nodes: GraphNode[]): Simulation
  links(links: GraphEdge[]): Simulation
  force(name: string, force: unknown): Simulation
  on(name: 'tick', cb: () => void): Simulation
  alpha(alpha: number): Simulation
  stop(): Simulation
}

interface ForceLinkConfig {
  links(links: GraphEdge[]): ForceLinkConfig
  id(fn: (node: GraphNode) => string): ForceLinkConfig
  distance(d: number): ForceLinkConfig
  strength(fn: (l: GraphEdge) => number): ForceLinkConfig
}

interface ForceManyBodyConfig {
  strength(d: number): ForceManyBodyConfig
}

interface D3ForceModule {
  forceSimulation(nodes?: GraphNode[]): Simulation
  forceLink(): ForceLinkConfig
  forceManyBody(): ForceManyBodyConfig
  forceCenter(x: number, y: number): unknown
}

let d3Force: D3ForceModule | null = null

/** 动态加载 d3-force（首次打开面板时拉起，失败置 null 由调用方提示） */
async function loadD3Force(): Promise<D3ForceModule | null> {
  if (d3Force) return d3Force
  try {
    d3Force = (await import('d3-force')) as unknown as D3ForceModule
    return d3Force
  } catch (err) {
    console.error('[tmd] d3-force 加载失败', err)
    return null
  }
}

/** 当前渲染上下文（面板打开期间有效） */
let ctx: {
  canvas: HTMLCanvasElement
  nodes: GraphNode[]
  edges: GraphEdge[]
  sim: Simulation
  view: { k: number; x: number; y: number }
  hover: GraphNode | null
  raf: number
} | null = null

function setStatus(text: string): void {
  const el = document.getElementById('graph-status')
  if (el) el.textContent = text
}

/** 关闭面板并停止模拟 */
export function closeGraph(): void {
  const overlay = document.getElementById('graph-overlay')
  if (overlay) overlay.setAttribute('hidden', '')
  if (ctx) {
    cancelAnimationFrame(ctx.raf)
    ctx.sim.stop()
    ctx = null
  }
}

/** 打开图谱面板：拉取索引、构建图、启动力导向模拟 */
export async function openGraph(): Promise<void> {
  const overlay = document.getElementById('graph-overlay')
  const canvas = document.getElementById('graph-canvas') as HTMLCanvasElement | null
  if (!overlay || !canvas) return
  overlay.hidden = false
  setStatus(t('graph.loading'))

  const mod = await loadD3Force()
  if (!overlay || overlay.hidden) return
  if (!mod) {
    setStatus(t('graph.loadFailed'))
    return
  }
  const scan = await getWikiLinks()
  if (!overlay || overlay.hidden) return
  if (!scan || scan.notes.length === 0) {
    setStatus(t('graph.empty'))
    return
  }

  // 节点：全部笔记；边：解析命中的引用（同对合并，重复计为 weight）
  const byPath = new Map<string, GraphNode>()
  for (const note of scan.notes) {
    byPath.set(note.path, {
      id: note.path,
      label: note.name.replace(/\.md$/i, ''),
      degree: 0,
    })
  }
  const edgeMap = new Map<string, GraphEdge>()
  for (const link of scan.links) {
    if (link.resolved.kind !== 'ok') continue
    const source = byPath.get(link.source)
    const target = byPath.get(link.resolved.path)
    if (!source || !target || source === target) continue
    const key =
      source.id < target.id ? `${source.id}\u0000${target.id}` : `${target.id}\u0000${source.id}`
    const existing = edgeMap.get(key)
    if (existing) existing.weight++
    else edgeMap.set(key, { source, target, weight: 1 })
  }
  const nodes = [...byPath.values()]
  const edges = [...edgeMap.values()]
  for (const e of edges) {
    const s = e.source as GraphNode
    const t2 = e.target as GraphNode
    s.degree++
    t2.degree++
  }

  setStatus(
    scan.truncated
      ? t('graph.truncated')
      : t('graph.summary', { count: nodes.length, links: edges.length }),
  )

  const width = canvas.clientWidth || 800
  const height = canvas.clientHeight || 500

  // 初始位置：以中心为圆心随机散布，帮助力导向快速收敛
  for (const node of nodes) {
    const angle = Math.random() * Math.PI * 2
    const radius = Math.min(width, height) * 0.35 * Math.sqrt(Math.random())
    node.x = width / 2 + Math.cos(angle) * radius
    node.y = height / 2 + Math.sin(angle) * radius
  }

  const sim = mod
    .forceSimulation(nodes)
    .force(
      'link',
      mod
        .forceLink()
        .links(edges)
        .id((node) => node.id)
        .distance(60)
        .strength((l) => 1 / Math.min(l.weight, 5)),
    )
    .force('charge', mod.forceManyBody().strength(-140))
    .force('center', mod.forceCenter(width / 2, height / 2))
  sim.alpha(1)

  ctx = { canvas, nodes, edges, sim, view: { k: 1, x: 0, y: 0 }, hover: null, raf: 0 }
  sim.on('tick', () => scheduleDraw())
  scheduleDraw()
}

/** 请求绘制（rAF 合帧） */
function scheduleDraw(): void {
  if (!ctx || ctx.raf) return
  ctx.raf = requestAnimationFrame(() => {
    if (ctx) ctx.raf = 0
    draw()
  })
}

/** 读取主题变量（每帧读取：主题/预设/自定义 CSS 切换即时跟随） */
function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 绘制一帧：边 → 节点 → 悬停邻居与标签 */
function draw(): void {
  if (!ctx) return
  const { canvas, nodes, edges, view, hover } = ctx
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, width, height)
  g.save()
  g.translate(view.x, view.y)
  g.scale(view.k, view.k)

  const fg = themeColor('--fg', '#24292f')
  const border = themeColor('--border', '#e2e6ea')
  const accent = themeColor('--accent', '#4a7cd4')
  const muted = themeColor('--muted', '#6a737d')

  // 邻居集合（悬停高亮用）
  const neighbors = new Set<GraphNode>()
  if (hover) {
    for (const e of edges) {
      const s = e.source as GraphNode
      const t2 = e.target as GraphNode
      if (s === hover) neighbors.add(t2)
      if (t2 === hover) neighbors.add(s)
    }
  }

  // 边：悬停时只画邻居边并加亮，其余淡化
  for (const e of edges) {
    const s = e.source as GraphNode
    const t2 = e.target as GraphNode
    if (s.x == null || s.y == null || t2.x == null || t2.y == null) continue
    const highlighted = hover && (s === hover || t2 === hover)
    g.strokeStyle = hover && !highlighted ? border : accent
    g.globalAlpha = hover ? (highlighted ? 0.9 : 0.15) : 0.35
    g.lineWidth = Math.min(1 + (e.weight - 1) * 0.75, 4)
    g.beginPath()
    g.moveTo(s.x, s.y)
    g.lineTo(t2.x, t2.y)
    g.stroke()
  }
  g.globalAlpha = 1

  // 节点：度数决定半径；悬停时非邻居淡化
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue
    const radius = 4 + Math.min(node.degree, 20) * 0.6
    const dimmed = hover && node !== hover && !neighbors.has(node)
    g.globalAlpha = hover && dimmed ? 0.2 : 1
    g.fillStyle = node === hover ? accent : fg
    g.beginPath()
    g.arc(node.x, node.y, radius, 0, Math.PI * 2)
    g.fill()
    if (node === hover) {
      g.strokeStyle = muted
      g.lineWidth = 2
      g.stroke()
    }
    // 悬停节点与其邻居显示标签（其余隐藏，避免大图文字噪）
    if (node === hover || (hover && neighbors.has(node)) || !hover) {
      g.fillStyle = node === hover ? accent : muted
      g.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      g.fillText(node.label, node.x + radius + 3, node.y + 4)
    }
  }
  g.globalAlpha = 1
  g.restore()
}

/** 屏幕坐标 → 图坐标（含缩放与平移） */
function toGraphCoords(
  canvas: HTMLCanvasElement,
  view: { k: number; x: number; y: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (clientX - rect.left - view.x) / view.k,
    y: (clientY - rect.top - view.y) / view.k,
  }
}

/** 命中测试：返回半径阈值内的节点（优先度高者） */
function hitNode(x: number, y: number): GraphNode | null {
  if (!ctx) return null
  let best: GraphNode | null = null
  let bestDist = 10
  for (const node of ctx.nodes) {
    if (node.x == null || node.y == null) continue
    const radius = 4 + Math.min(node.degree, 20) * 0.6
    const dist = Math.hypot(node.x - x, node.y - y)
    if (dist <= radius + 4 && dist < bestDist) {
      best = node
      bestDist = dist
    }
  }
  return best
}

/** 面板事件装配（boot 调用一次） */
export function wireGraph(): void {
  const overlay = document.getElementById('graph-overlay')
  const canvas = document.getElementById('graph-canvas') as HTMLCanvasElement | null
  if (!overlay || !canvas) return

  // 指针状态：拖拽节点 / 平移画布共用 pointer 事件
  let dragNode: GraphNode | null = null
  let panning = false
  let lastPointer = { x: 0, y: 0 }
  let moved = false

  canvas.addEventListener('pointerdown', (e) => {
    if (!ctx) return
    const point = toGraphCoords(canvas, ctx.view, e.clientX, e.clientY)
    dragNode = hitNode(point.x, point.y)
    panning = !dragNode
    moved = false
    lastPointer = { x: e.clientX, y: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!ctx) return
    const dx = e.clientX - lastPointer.x
    const dy = e.clientY - lastPointer.y
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
    if (dragNode) {
      const point = toGraphCoords(canvas, ctx.view, e.clientX, e.clientY)
      dragNode.fx = point.x
      dragNode.fy = point.y
      ctx.sim.alpha(0.3)
      scheduleDraw()
    } else if (panning) {
      ctx.view.x += dx
      ctx.view.y += dy
      lastPointer = { x: e.clientX, y: e.clientY }
      scheduleDraw()
      return
    }
    lastPointer = { x: e.clientX, y: e.clientY }
    const point = toGraphCoords(canvas, ctx.view, e.clientX, e.clientY)
    ctx.hover = hitNode(point.x, point.y)
    canvas.style.cursor = dragNode || ctx.hover ? 'grab' : 'default'
    scheduleDraw()
  })
  canvas.addEventListener('pointerup', (e) => {
    if (!ctx) return
    // 点击（未拖动）节点 → 打开笔记
    if (dragNode && !moved) void openPath(dragNode.id)
    if (dragNode) {
      dragNode.fx = null
      dragNode.fy = null
    }
    dragNode = null
    panning = false
    canvas.releasePointerCapture(e.pointerId)
    scheduleDraw()
  })
  canvas.addEventListener('wheel', (e) => {
    if (!ctx) return
    e.preventDefault()
    // 以指针为缩放中心
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const k = Math.min(Math.max(ctx.view.k * factor, 0.2), 5)
    ctx.view.x = px - ((px - ctx.view.x) * k) / ctx.view.k
    ctx.view.y = py - ((py - ctx.view.y) * k) / ctx.view.k
    ctx.view.k = k
    scheduleDraw()
  })
  // 窗口尺寸变化重绘（canvas 尺寸在 draw 内按容器自适应）
  window.addEventListener('resize', scheduleDraw)
  // 点击遮罩空白处关闭；面板头部 ✕ 为显式出口
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeGraph()
  })
  document.getElementById('graph-close-btn')?.addEventListener('click', () => closeGraph())
}
