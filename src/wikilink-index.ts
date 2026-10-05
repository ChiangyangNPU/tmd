/**
 * 双链索引的渲染层缓存与失效调度。
 *
 * 索引按需扫描（无常驻增量维护）：缓存命中直接用；未就绪时解析返回
 * pending（装饰不着色、点击不响应），扫描完成经 notifyWikilinkIndexChanged
 * 触发装饰重算。失效不立即重扫——保存场景以「内容含 [[ 」为门槛 + 防抖
 * 调度（自动保存高频，无双链的文档零开销），改名/新建/文件夹变更直接调度。
 *
 * 解析规则与 electron/wikilinks.cjs 的 resolveTarget 同构（渲染层不能
 * require CJS，改动需两侧同步）：相对路径 → 同目录同名 → 全工作区唯一名。
 * 区别：键用 normalizePath 归一（渲染层无 path 模块，且 Windows 侧
 * 主进程给的是反斜杠原生路径，归一后与点击解析的拼接结果对齐）。
 *
 * @author chiangyang
 */
import { normalizePath } from './link-nav'
import { notifyWikilinkIndexChanged, type WikiResolution } from './wikilink'
import { native, type WikiScanResult } from './native'

let cache: WikiScanResult | null = null
let nameIndex: NameIndexEntry | null = null
let inflight: Promise<WikiScanResult | null> | null = null

/** 工作区根目录来源（main.ts 注入：挂载文件夹 + 当前文档目录） */
let getRoots: () => string[] = () => []

/** main.ts 启动时注入根目录来源 */
export function setWikilinkRootsProvider(fn: () => string[]): void {
  getRoots = fn
}

function currentRoots(): string[] {
  return [...new Set(getRoots())].filter((r) => r && r !== '')
}

/**
 * 确保索引可用（单飞）：有缓存直接返回；否则按当前根目录扫描。
 * @param force - true 时丢弃缓存强制重扫（改名/新建/文件夹变更后的显式刷新）
 */
export async function ensureWikiIndex(force = false): Promise<WikiScanResult | null> {
  if (!native) return null
  if (cache && !force) return cache
  if (inflight) return inflight
  const roots = currentRoots()
  if (!roots.length) return null
  inflight = native
    .wikiScan(roots)
    .then((res) => {
      cache = res
      nameIndex = null
      notifyWikilinkIndexChanged()
      return res
    })
    .catch(() => null)
    .finally(() => {
      inflight = null
    })
  return inflight
}

let rescanTimer: ReturnType<typeof setTimeout> | undefined

/** 丢弃缓存并按需调度重扫（下一次 ensure 时生效） */
export function invalidateWikiIndex(rescan = false): void {
  cache = null
  nameIndex = null
  notifyWikilinkIndexChanged()
  if (rescan) scheduleRescan()
}

/** 保存后调用：内容含 [[ 才调度防抖重扫（无双链文档零开销） */
export function wikiIndexOnSave(markdown: string): void {
  if (!markdown.includes('[[')) return
  scheduleRescan()
}

function scheduleRescan(): void {
  clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => {
    void ensureWikiIndex(true)
  }, 1500)
}

// ---------------------------------------------------------------------------
// 渲染层解析（与主进程 resolveTarget 同构，键经 normalizePath 归一）
// ---------------------------------------------------------------------------

interface NameIndexEntry {
  byPath: Map<string, string>
  byName: Map<string, string[]>
}

/** 从缓存构建名字索引（缓存刷新后置空，下次解析重建；开销 O(n)） */
function ensureNameIndex(): NameIndexEntry | null {
  if (!cache) return null
  if (nameIndex) return nameIndex
  const byPath = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const note of cache.notes) {
    const norm = normalizePath(note.path).toLowerCase()
    byPath.set(norm, note.path)
    const key = note.name.replace(/\.md$/i, '').toLowerCase()
    const list = byName.get(key)
    if (list) list.push(note.path)
    else byName.set(key, [note.path])
  }
  nameIndex = { byPath, byName }
  return nameIndex
}

/**
 * 同步解析（装饰着色与点击共用）：缓存未就绪返回 pending。
 * @param target - wikilink target（不含 [[ ]]）
 * @param sourcePath - 链接所在文档绝对路径（相对路径与空目标的基准；可为 null）
 */
export function resolveWikiTarget(target: string, sourcePath: string | null): WikiResolution {
  if (!cache) return { kind: 'pending' }
  const t = target.trim()
  // 空目标（[[#标题]]）= 自身文档
  if (!t) return sourcePath ? { kind: 'ok', path: sourcePath } : { kind: 'missing' }
  const index = ensureNameIndex()
  if (!index) return { kind: 'pending' }
  const withMd = /\.md$/i.test(t) ? t : `${t}.md`
  if (/[/\\]/.test(t)) {
    if (!sourcePath) return { kind: 'missing' }
    const joined = normalizePath(`${dirOf(sourcePath)}/${withMd}`)
    const hit = index.byPath.get(joined.toLowerCase())
    return hit ? { kind: 'ok', path: hit } : { kind: 'missing' }
  }
  if (sourcePath) {
    const sameDir = index.byPath.get(normalizePath(`${dirOf(sourcePath)}/${withMd}`).toLowerCase())
    if (sameDir) return { kind: 'ok', path: sameDir }
  }
  const list = index.byName.get(`${t.replace(/\.md$/i, '').toLowerCase()}`)
  if (!list || list.length === 0) return { kind: 'missing' }
  if (list.length === 1) return { kind: 'ok', path: list[0] }
  return { kind: 'ambiguous', paths: list }
}

/** 取目录部分（统一正斜杠；根目录返回 ''） */
function dirOf(p: string): string {
  const norm = p.replaceAll('\\', '/')
  const i = norm.lastIndexOf('/')
  return i > 0 ? norm.slice(0, i) : ''
}

/**
 * 取全部链接边（反链面板 / 图谱 / 改名重写共用）：缓存未就绪时先扫描。
 * 返回前调用方应检查 truncated 提示截断。
 */
export async function getWikiLinks(): Promise<WikiScanResult | null> {
  return ensureWikiIndex()
}
