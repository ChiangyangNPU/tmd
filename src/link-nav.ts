/**
 * 链接点击跳转：Ctrl/Cmd+点击文档内链接跳浏览器 / 打开本地文件。
 *
 * - http/https → shell.openExternal（主进程校验协议白名单）
 * - 本地路径（绝对 / file:// / 相对路径按当前文档目录解析）→ shell.openPath
 * - mailto:、tel:、文内 #锚点 v1 不处理
 * - 浏览器模式无壳层 API（native 为空），点击不响应，自然降级
 *
 * 悬停提示：按住 Mod 键时编辑区链接显示 pointer 光标（wireLinkNav 装配）。
 *
 * @author chiangyang
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { native } from './native'

/** 链接解析结果：外部 URL 或本地文件绝对路径 */
export type LinkTarget = { kind: 'external'; url: string } | { kind: 'file'; path: string }

/**
 * 规范化路径：反斜杠统一为正斜杠，解析 `./` 与 `../` 段
 * （输入通常是 baseDir + 相对链接的拼接结果）。
 *
 * Windows 上 baseDir 来自主进程 path.join（含反斜杠），若不先统一分隔符，
 * 整段会被当作一个路径段而无法解析 `./` 与 `../`；
 * 盘符路径保持 `E:/a/b` 形态（`/E:/a/b` 不是合法 Windows 路径），
 * POSIX 路径则保持以 `/` 开头的绝对形式。
 */
export function normalizePath(path: string): string {
  const unified = path.replaceAll('\\', '/')
  const hasDrive = /^[a-zA-Z]:\//.test(unified)
  const out: string[] = []
  for (const seg of unified.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  const joined = out.join('/')
  return hasDrive ? joined : '/' + joined
}

/** 是否为绝对路径（POSIX 的 `/` 开头，或 Windows 的 `E:\` / `E:/` 盘符形式） */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)
}

/**
 * 把链接 href 解析为跳转目标：
 * - http/https → external
 * - file:// 与绝对路径 → file
 * - 相对路径 → 以 baseDir 为基准解析；baseDir 缺失（文档未保存）时返回 null
 * - mailto:/tel:/#锚点 → null（v1 不处理）
 */
export function resolveLink(href: string, baseDir: string | null): LinkTarget | null {
  const trimmed = href.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'external', url: trimmed }
  if (/^(mailto|tel):/i.test(trimmed)) return null
  if (trimmed.startsWith('#')) return null

  let p = trimmed
  if (p.startsWith('file://')) p = p.slice('file://'.length)
  try {
    p = decodeURIComponent(p)
  } catch {
    // 含未转义的特殊字符：按原样继续
  }
  p = p.split('#')[0].split('?')[0]
  if (!p) return null
  if (isAbsolutePath(p)) return { kind: 'file', path: normalizePath(p) }
  if (!baseDir) return null
  return { kind: 'file', path: normalizePath(`${baseDir}/${p}`) }
}

/** 跳转上下文：目录来自当前标签页的文件路径（main.ts 装配注入） */
interface LinkNavContext {
  getBaseDir(): string | null
}

let context: LinkNavContext = { getBaseDir: () => null }

/** main.ts 启动时注入跳转上下文 */
export function setLinkNavContext(next: LinkNavContext) {
  context = next
}

/** 按目标类型跳转（浏览器模式 native 缺失时不响应） */
async function followTarget(target: LinkTarget): Promise<void> {
  if (!native) return
  if (target.kind === 'external') {
    await native.openExternal(target.url)
  } else {
    const err = await native.openLocalFile(target.path)
    if (err) console.warn(`[tmd] 无法打开本地文件：${target.path}（${err}）`)
  }
}

/** 当前点击位置是否带 link 标记，返回 href */
function linkHrefAt(view: EditorView, pos: number): string | null {
  const link = view.state.schema.marks.link
  if (!link) return null
  const mark = view.state.doc
    .resolve(pos)
    .marks()
    .find((m) => m.type === link)
  return mark ? (mark.attrs.href as string) : null
}

/** mod（macOS Cmd / 其他 Ctrl）+ 点击：落在链接上时跳转 */
function isModClick(event: MouseEvent): boolean {
  return navigator.userAgent.includes('Macintosh') ? event.metaKey : event.ctrlKey
}

/** 链接点击跳转插件 */
export const linkNav = $prose(
  () =>
    new Plugin({
      props: {
        handleClick: (view, pos, event) => {
          if (!isModClick(event)) return false
          const href = linkHrefAt(view, pos)
          if (!href) return false
          const target = resolveLink(href, context.getBaseDir())
          if (!target) return false
          event.preventDefault()
          void followTarget(target)
          return true
        },
      },
    }),
)

/** 悬停提示装配：按住 Mod 键时编辑区链接显示 pointer 光标（boot 调用一次） */
export function wireLinkNav(): void {
  const editorEl = document.getElementById('editor')
  if (!editorEl) return
  const sync = (pressed: boolean) => {
    editorEl.classList.toggle('mod-pressed', pressed)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') sync(true)
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Meta' || e.key === 'Control') sync(false)
  })
  window.addEventListener('blur', () => sync(false))
}
