/**
 * 侧边栏文件管理的纯函数集合（新建 / 重命名的名称安全与路径拼装）。
 *
 * 渲染层传来的名称不可信：拒绝空名、路径分隔符、目录穿越片段、控制字符
 * 与隐藏文件；拼装路径后二次校验 basename 未被名称变换破坏，杜绝越出
 * 目标目录。纯 Node 模块，可脱壳单测（与 filewatcher.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')

/** 名称长度上限（与常见文件系统上限一致） */
const MAX_NAME_LENGTH = 255

/**
 * 清洗用户输入的文件/文件夹名：非法返回 null，合法返回 trim 后的名称。
 * 拒绝：空串、纯点（. / ..）、含路径分隔符（/ \\）、含控制字符、
 * 以点开头（隐藏文件，也挡住 macOS 的 .DS_Store 类冲突）、超长。
 * @param {unknown} name
 * @returns {string | null}
 */
function sanitizeFileName(name) {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null
  if (trimmed.startsWith('.')) return null
  if (/[/\\]/.test(trimmed)) return null
  if (trimmed === '.' || trimmed === '..') return null
  if (/\p{Cc}/u.test(trimmed)) return null
  return trimmed
}

/**
 * 目录 + 已清洗名称 → 子路径；二次防线：join 后 basename 必须与名称一致
 * （防止任何未预料的名称变换把路径挪出目标目录）。
 * @param {unknown} dir @param {unknown} name
 * @returns {string | null}
 */
function childPath(dir, name) {
  if (typeof dir !== 'string' || !dir) return null
  const safe = sanitizeFileName(name)
  if (!safe) return null
  const joined = path.join(dir, safe)
  return path.basename(joined) === safe ? joined : null
}

/**
 * 新建文件的落盘名：无 .md 扩展名时补上（Markdown 编辑器的新建语义）。
 * @param {string} name 已清洗的名称
 * @returns {string}
 */
function ensureMarkdownExt(name) {
  return /\.md$/i.test(name) ? name : `${name}.md`
}

module.exports = { sanitizeFileName, childPath, ensureMarkdownExt, MAX_NAME_LENGTH }
