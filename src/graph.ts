/**
 * 关系图谱面板：以力导向布局呈现工作区笔记的双链关系。
 *
 * 数据来自双链索引（wikilink-index 的按需扫描）：节点 = 笔记 + 未解析
 * 幽灵节点，边 = 解析命中的 [[..]]（同对笔记多条引用合并为一条，重复
 * 计数为线宽）。布局用 d3-force（动态 import 懒加载为独立 chunk），绘制
 * 用 canvas 2d。
 *
 * 对齐 Obsidian 的能力（设置经 tmd:graph-settings 持久化，弹层内调整）：
 * - 幽灵节点：未解析目标入图（空心虚线圆），提示「待写笔记」；
 * - 方向箭头：连线 target 端小三角；
 * - 孤立笔记显隐、笔记名/路径子串过滤（非匹配淡化仍占位）；
 * - 按文件夹着色（挂载根 → 内置色板循环，Color Groups 的轻量替代）；
 * - 力参数滑杆（斥力 / 连线距离 / 居中力）实时生效；
 * - 拖拽节点即固定（fx/fy 保留），双击解钉，「重置布局」全部解钉重跑。
 *
 * 交互：滚轮缩放（以指针为中心）/ 空白拖拽平移 / 悬停高亮邻居并淡化
 * 其余 / 点击节点打开笔记。颜色主题变量每帧读取，深浅/预设/自定义 CSS
 * 切换即时跟随。
 *
 * @author chiangyang
 */
import { t } from './i18n'
import { normalizePath } from './link-nav'
import { showToast, openPath } from './files'
import { folderList, getGraphSettings, setGraphSettings, type GraphSettings } from './store'
import { getWikiLinks } from './wikilink-index'
import type { WikiLinkRef } from './native'

interface SimulationNodeDatum {
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
  vx?: number
  vy?: number
  index?: number
}

interface GraphNode extends SimulationNodeDatum {
  id: string
  label: string
  degree: number
  /** 未解析幽灵节点（目标笔记不存在） */
  ghost?: boolean
  /** 文件夹着色（null = 用前景色） */
  color?: string | null
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

interface ForcePositionConfig {
  strength(s: number): ForcePositionConfig
}

interface D3ForceModule {
  forceSimulation(nodes?: GraphNode[]): Simulation
  forceLink(): ForceLinkConfig
  forceManyBody(): ForceManyBodyConfig
  forceX(x: number): ForcePositionConfig
  forceY(y: number): ForcePositionConfig
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

// ---------------------------------------------------------------------------
// 纯函数层（导出供单测）：着色 / 过滤 / 图数据构建
// ---------------------------------------------------------------------------

/** 文件夹着色色板（中饱和度，深浅主题下均可读；按挂载顺序循环取色） */
export const GRAPH_PALETTE = ['#4a7cd4', '#59a86c', '#d4884a', '#9a6fd0', '#38a3a8', '#d46a9a']

/**
 * 节点所属挂载文件夹的着色：路径落在第 i 个挂载根之下 → 色板第 i % len 色。
 * 不属任何根（未挂载的独立文档）或功能关闭返回 null（调用方用前景色）。
 */
export function folderColorFor(notePath: string, roots: string[], enabled: boolean): string | null {
  if (!enabled || roots.length === 0) return null
  const norm = normalizePath(notePath).toLowerCase()
  for (let i = 0; i < roots.length; i++) {
    const root = normalizePath(roots[i]).toLowerCase().replace(/\/$/, '')
    if (norm === root || norm.startsWith(root + '/')) {
      return GRAPH_PALETTE[i % GRAPH_PALETTE.length]
    }
  }
  return null
}

/** 搜索过滤：笔记名或路径含子串（大小写不敏感）即匹配；空 query 全匹配 */
export function matchesQuery(label: string, notePath: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return label.toLowerCase().includes(q) || notePath.toLowerCase().includes(q)
}

/** 从链接列表收集未解析目标（去重、保序、跳过空目标）；导出供单测 */
export function collectGhostTargets(links: WikiLinkRef[]): string[] {
  const out: string[] = []
  for (const l of links) {
    if (l.resolved.kind === 'ok') continue
    const target = l.target.trim()
    if (target && !out.includes(target)) out.push(target)
  }
  return out
}

/** 图数据构建选项 */
export interface BuildGraphOpts {
  /** 未解析目标是否入图为幽灵节点 */
  showGhosts: boolean
}

/**
 * 从扫描结果构建图数据：节点 = 笔记（+ 可选幽灵），边 = 解析命中的引用
 * （同对合并为 weight）。自引（[[#标题]]）与未命中目标的链接按选项落为
 * 幽灵边或丢弃。导出供单测。
 */
export function buildGraphData(
  notes: { path: string; name: string }[],
  links: WikiLinkRef[],
  opts: BuildGraphOpts,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byPath = new Map<string, GraphNode>()
  const nodes: GraphNode[] = []
  for (const note of notes) {
    const node: GraphNode = { id: note.path, label: note.name.replace(/\.md$/i, ''), degree: 0 }
    byPath.set(note.path, node)
    nodes.push(node)
  }
  const edges: GraphEdge[] = []
  const edgeKeys = new Map<string, GraphEdge>()
  const addEdge = (source: GraphNode, target: GraphNode) => {
    source.degree++
    target.degree++
    const key =
      source.id < target.id ? `${source.id}\u0000${target.id}` : `${target.id}\u0000${source.id}`
    const existing = edgeKeys.get(key)
    if (existing) existing.weight++
    else {
      const edge: GraphEdge = { source, target, weight: 1 }
      edgeKeys.set(key, edge)
      edges.push(edge)
    }
  }
  for (const link of links) {
    const source = byPath.get(link.source)
    if (!source) continue
    if (link.resolved.kind === 'ok') {
      const target = byPath.get(link.resolved.path)
      if (target && target !== source) addEdge(source, target)
      continue
    }
    if (!opts.showGhosts) continue
    const target = link.target.trim()
    if (!target) continue
    const ghostId = `ghost:${target}`
    let ghost = byPath.get(ghostId)
    if (!ghost) {
      ghost = { id: ghostId, label: target, degree: 0, ghost: true }
      byPath.set(ghostId, ghost)
      nodes.push(ghost)
    }
    addEdge(source, ghost)
  }
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// 面板状态与开合
// ---------------------------------------------------------------------------

interface GraphContext {
  canvas: HTMLCanvasElement
  nodes: GraphNode[]
  edges: GraphEdge[]
  sim: Simulation
  forces: {
    charge: ForceManyBodyConfig
    link: ForceLinkConfig
    x: ForcePositionConfig
    y: ForcePositionConfig
  }
  view: { k: number; x: number; y: number }
  hover: GraphNode | null
  raf: number
}

let ctx: GraphContext | null = null

let settings: GraphSettings | null = null

function currentSettings(): GraphSettings {
  if (!settings) settings = getGraphSettings()
  return settings
}

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

  const s = currentSettings()
  const { nodes, edges } = buildGraphData(scan.notes, scan.links, {
    showGhosts: s.showGhosts,
  })
  const roots = folderList().map((f) => f.path)
  for (const node of nodes) {
    if (!node.ghost) node.color = folderColorFor(node.id, roots, s.colorByFolder)
  }

  setStatus(
    scan.truncated
      ? t('graph.truncated')
      : t('graph.summary', {
          count: nodes.filter((n) => !n.ghost).length,
          links: edges.length,
        }),
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

  const cs = s.centerStrength
  const charge = mod.forceManyBody().strength(s.repel)
  const link = mod
    .forceLink()
    .links(edges)
    .id((node) => node.id)
    .distance(s.linkDistance)
    .strength((l) => 1 / Math.min(l.weight, 5))
  const fx = mod.forceX(width / 2).strength(cs)
  const fy = mod.forceY(height / 2).strength(cs)
  const sim = mod
    .forceSimulation(nodes)
    .force('link', link)
    .force('charge', charge)
    .force('x', fx)
    .force('y', fy)
  sim.alpha(1)

  ctx = {
    canvas,
    nodes,
    edges,
    sim,
    forces: { charge, link, x: fx, y: fy },
    view: { k: 1, x: 0, y: 0 },
    hover: null,
    raf: 0,
  }
  sim.on('tick', () => scheduleDraw())
  scheduleDraw()
}

/** 应用设置增量：持久化 + 更新力参数 + 重热 + 重绘（显隐类仅重绘） */
export function applyGraphSettings(patch: Partial<GraphSettings>): void {
  settings = { ...currentSettings(), ...patch }
  setGraphSettings(patch)
  if (ctx) {
    ctx.forces.charge.strength(settings.repel)
    ctx.forces.link.distance(settings.linkDistance)
    ctx.forces.x.strength(settings.centerStrength)
    ctx.forces.y.strength(settings.centerStrength)
    ctx.sim.alpha(0.5)
  }
  scheduleDraw()
}

/** 重置布局：清除全部钉住并重跑模拟 */
export function resetGraphLayout(): void {
  if (!ctx) return
  for (const node of ctx.nodes) {
    node.fx = null
    node.fy = null
  }
  ctx.sim.alpha(1)
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

/** 绘制一帧：边（+箭头）→ 节点 → 悬停邻居与标签 */
function draw(): void {
  if (!ctx) return
  const { canvas, nodes, edges, view, hover } = ctx
  const s = currentSettings()
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

  const nodeRadius = (node: GraphNode) => (node.ghost ? 4 : 4 + Math.min(node.degree, 20) * 0.6)

  // 可见性与淡漠判定：幽灵/孤立开关、搜索过滤（非匹配淡化仍占位）
  const visible = (node: GraphNode): boolean => {
    if (node.ghost && !s.showGhosts) return false
    if (!node.ghost && node.degree === 0 && !s.showOrphans) return false
    return true
  }
  const dimmed = (node: GraphNode): boolean => {
    if (s.query && !matchesQuery(node.label, node.id, s.query)) return true
    return false
  }

  // 邻居集合（悬停高亮用）
  const neighbors = new Set<GraphNode>()
  if (hover) {
    for (const e of edges) {
      const src = e.source as GraphNode
      const dst = e.target as GraphNode
      if (src === hover) neighbors.add(dst)
      if (dst === hover) neighbors.add(src)
    }
  }

  // 边：悬停时只画邻居边并加亮；过滤非匹配端淡化
  for (const e of edges) {
    const src = e.source as GraphNode
    const dst = e.target as GraphNode
    if (!visible(src) || !visible(dst)) continue
    if (src.x == null || src.y == null || dst.x == null || dst.y == null) continue
    const highlighted = hover && (src === hover || dst === hover)
    const faded = dimmed(src) || dimmed(dst)
    g.strokeStyle = hover && !highlighted ? border : accent
    g.globalAlpha = hover ? (highlighted ? 0.9 : 0.15) : faded ? 0.15 : 0.35
    g.lineWidth = Math.min(1 + (e.weight - 1) * 0.75, 4)
    const dx = dst.x - src.x
    const dy = dst.y - src.y
    const len = Math.hypot(dx, dy) || 1
    const tr = nodeRadius(dst) + 2
    g.beginPath()
    g.moveTo(src.x, src.y)
    g.lineTo(dst.x - (dx / len) * tr, dst.y - (dy / len) * tr)
    g.stroke()
    // 方向箭头：target 端小三角
    if (s.showArrows) {
      const ax = dst.x - (dx / len) * tr
      const ay = dst.y - (dy / len) * tr
      const size = 4 + Math.min(e.weight, 3)
      g.beginPath()
      g.moveTo(ax, ay)
      g.lineTo(
        ax - (dx / len) * size * 2 - (dy / len) * size,
        ay - (dy / len) * size * 2 + (dx / len) * size,
      )
      g.lineTo(
        ax - (dx / len) * size * 2 + (dy / len) * size,
        ay - (dy / len) * size * 2 - (dx / len) * size,
      )
      g.closePath()
      g.fillStyle = hover && !highlighted ? border : accent
      g.fill()
    }
  }
  g.globalAlpha = 1

  // 节点：幽灵空心虚线圆；普通节点度数定半径；过滤/悬停控制淡漠
  for (const node of nodes) {
    if (!visible(node)) continue
    if (node.x == null || node.y == null) continue
    const radius = nodeRadius(node)
    const dimmedNode = dimmed(node)
    const isHover = node === hover
    g.globalAlpha = hover
      ? isHover || neighbors.has(node)
        ? 1
        : dimmedNode
          ? 0.08
          : 0.2
      : dimmedNode
        ? 0.15
        : 1
    if (node.ghost) {
      g.strokeStyle = muted
      g.lineWidth = 1.5
      g.setLineDash([3, 3])
      g.beginPath()
      g.arc(node.x, node.y, radius, 0, Math.PI * 2)
      g.stroke()
      g.setLineDash([])
    } else {
      g.fillStyle = isHover ? accent : (s.colorByFolder && node.color) || fg
      g.beginPath()
      g.arc(node.x, node.y, radius, 0, Math.PI * 2)
      g.fill()
      if (isHover) {
        g.strokeStyle = muted
        g.lineWidth = 2
        g.stroke()
      }
    }
    // 悬停节点与其邻居显示标签（其余隐藏，避免大图文字噪）
    if (isHover || (hover && neighbors.has(node)) || !hover) {
      g.fillStyle = isHover ? accent : muted
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
    if (!currentSettings().showGhosts && node.ghost) continue
    if (!currentSettings().showOrphans && node.degree === 0 && !node.ghost) continue
    if (node.x == null || node.y == null) continue
    const radius = node.ghost ? 4 : 4 + Math.min(node.degree, 20) * 0.6
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
      // 拖拽即固定（fx/fy 保留）：松手后停在此处，双击解钉
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
    // 点击（未拖动）节点 → 打开笔记；幽灵节点提示不存在
    if (dragNode && !moved) {
      if (dragNode.ghost) showToast(t('wikilink.notFound', { target: dragNode.label }))
      else void openPath(dragNode.id)
    }
    // 拖拽即固定：保留 fx/fy（Obsidian 同款），双击解钉
    dragNode = null
    panning = false
    canvas.releasePointerCapture(e.pointerId)
    scheduleDraw()
  })
  // 双击节点解除固定
  canvas.addEventListener('dblclick', (e) => {
    if (!ctx) return
    const point = toGraphCoords(canvas, ctx.view, e.clientX, e.clientY)
    const node = hitNode(point.x, point.y)
    if (node && node.fx != null) {
      node.fx = null
      node.fy = null
      ctx.sim.alpha(0.5)
      scheduleDraw()
    }
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

  // ---------- 设置弹层 ----------
  const pop = document.getElementById('graph-settings-pop')
  document.getElementById('graph-settings-btn')?.addEventListener('click', () => {
    if (!pop) return
    pop.hidden = !pop.hidden
    if (!pop.hidden) reflectSettings()
  })
  const bindCheckbox = (
    id: string,
    key: 'showGhosts' | 'showArrows' | 'showOrphans' | 'colorByFolder',
  ) => {
    document.getElementById(id)?.addEventListener('change', (e) => {
      applyGraphSettings({ [key]: (e.target as HTMLInputElement).checked })
    })
  }
  bindCheckbox('graph-opt-ghosts', 'showGhosts')
  bindCheckbox('graph-opt-arrows', 'showArrows')
  bindCheckbox('graph-opt-orphans', 'showOrphans')
  bindCheckbox('graph-opt-color', 'colorByFolder')
  document.getElementById('graph-filter')?.addEventListener('input', (e) => {
    applyGraphSettings({ query: (e.target as HTMLInputElement).value })
  })
  document.getElementById('graph-repel')?.addEventListener('input', (e) => {
    applyGraphSettings({ repel: Number((e.target as HTMLInputElement).value) })
  })
  document.getElementById('graph-link-dist')?.addEventListener('input', (e) => {
    applyGraphSettings({ linkDistance: Number((e.target as HTMLInputElement).value) })
  })
  document.getElementById('graph-center')?.addEventListener('input', (e) => {
    applyGraphSettings({ centerStrength: Number((e.target as HTMLInputElement).value) })
  })
  document.getElementById('graph-reset-layout')?.addEventListener('click', () => resetGraphLayout())

  /** 把当前设置回填进弹层控件（每次展开弹层时同步） */
  function reflectSettings(): void {
    const s = currentSettings()
    const set = (id: string, prop: 'checked' | 'value', value: string | boolean | number) => {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (el) (el as unknown as Record<string, unknown>)[prop] = value
    }
    set('graph-opt-ghosts', 'checked', s.showGhosts)
    set('graph-opt-arrows', 'checked', s.showArrows)
    set('graph-opt-orphans', 'checked', s.showOrphans)
    set('graph-opt-color', 'checked', s.colorByFolder)
    set('graph-filter', 'value', s.query)
    set('graph-repel', 'value', s.repel)
    set('graph-link-dist', 'value', s.linkDistance)
    set('graph-center', 'value', s.centerStrength)
  }
}
