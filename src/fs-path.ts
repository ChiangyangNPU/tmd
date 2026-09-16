/**
 * 文件系统路径工具
 *
 * 项目里的路径有三处来源：主进程 path.join（Windows 下为反斜杠）、渲染层拼接、
 * 文档内链接。任何比较、去重、展示之前都应先经 normalizeFsPath 规范化，
 * 否则同一文件会因分隔符不同被当作两个（Windows 上尤其明显）。
 *
 * 与 link-nav.ts 的 normalizePath 的分工：
 * - normalizePath 服务「文档内链接跳转」，输入是 URL 风格路径，输出保证以 / 开头
 * - 本模块服务本地文件系统路径，保留 Windows 盘符形态（E:/a/b），不补前导斜杠
 *
 * @author chiangyang
 */

/** 盘符开头的 Windows 路径（`E:\` 或 `E:/`） */
const DRIVE_RE = /^[a-zA-Z]:[\\/]/

/**
 * 是否为 Windows 风格路径（盘符开头、UNC 路径或含反斜杠）
 * @param p - 待判断的路径
 * @returns 是否 Windows 风格
 */
export function isWindowsPath(p: string): boolean {
  return DRIVE_RE.test(p) || p.startsWith('\\\\') || p.includes('\\')
}

/**
 * 规范化文件系统路径：反斜杠统一为正斜杠，折叠重复分隔符与 `.` / `..` 段。
 *
 * 保留盘符前缀（不为其补前导斜杠），因此 `E:\a\..\b` → `E:/b`，
 * 而 POSIX 路径 `/a/../b` → `/b`。仅做字符串层面规整，不访问磁盘。
 *
 * @param p - 待规范化的路径
 * @returns 规范化后的路径
 */
export function normalizeFsPath(p: string): string {
  const unified = p.replaceAll('\\', '/')
  const hasDrive = DRIVE_RE.test(unified)
  const isAbsolutePosix = unified.startsWith('/')
  const out: string[] = []
  for (const seg of unified.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length) out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (hasDrive) return joined
  return isAbsolutePosix ? `/${joined}` : joined
}

/**
 * 取路径的目录部分（兼容 `/` 与 `\`；无分隔符时返回空串）。
 * 仅截断到最后一个分隔符，不做补全，故不依赖 path 模块。
 * @param p - 路径
 * @returns 目录部分
 */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : ''
}

/**
 * 把文档目录与相对路径拼成可直接用于 img.src 的 file:// URL。
 * 反斜杠统一为正斜杠（Windows 路径）；POSIX 与盘符路径补对应前导斜杠；
 * '#' 需转义为 %23，否则会被浏览器当作 URL 片段截断文件名。
 *
 * 编辑器显示解析（image-resolver）与导出图片本地化（export-doc）共用，
 * 保证两处对同一路径的 file:// 结果完全一致。
 *
 * @param dir - 文档所在目录的绝对路径
 * @param src - 文档内保存的相对路径（如 assets/xxx.png）
 * @returns file:// 开头的绝对地址
 */
export function toFileUrl(dir: string, src: string): string {
  const normalized = `${dir.replaceAll('\\', '/')}/${src.replaceAll('\\', '/')}`
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///'
  return `${prefix}${encodeURI(normalized).replaceAll('#', '%23')}`
}

/**
 * 判断两个路径是否指向同一文件：规范化后比较，Windows 风格路径忽略大小写。
 * @param a - 路径一
 * @param b - 路径二
 * @returns 是否视为同一路径
 */
export function isSameFsPath(a: string, b: string): boolean {
  const na = normalizeFsPath(a)
  const nb = normalizeFsPath(b)
  if (na === nb) return true
  return isWindowsPath(na) && na.toLowerCase() === nb.toLowerCase()
}
