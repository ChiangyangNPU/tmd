/**
 * 文件式主题：主题目录扫描、文件名安全校验与读取。
 *
 * 独立成模块（不依赖 Electron）：主进程 IPC handler 只做参数校验与结果包装，
 * 扫描/校验这部分纯 Node 逻辑可被单测直接 require 验证（与 search.cjs 同构）。
 *
 * 约定：
 * - 目录：~/.tmd/themes（用户主目录，跨安装/升级保留；主题是用户资产，
 *   不同于随卸载清理的 userData 配置）
 * - 一个 *.css 文件 = 一个主题，文件名（去 .css 扩展名）即主题显示名，
 *   支持中文等任意 Unicode 文件名
 * - 只扫描一层；忽略隐藏文件与非 .css 文件
 * - 读取只接受单层裸文件名（basename 校验），杜绝路径穿越
 *
 * @author chiangyang
 */
const fs = require('node:fs/promises')
const path = require('node:path')

/** 主题文件扩展名（大小写不敏感） */
const THEME_EXT_RE = /\.css$/i
/** 单个主题文件大小上限（1MB，远超正常 CSS 体量，仅为兜底） */
const THEME_MAX_SIZE = 1024 * 1024

/**
 * 主题目录绝对路径：~/.tmd/themes。
 * @param {string} home - app.getPath('home')（用户主目录）
 * @returns {string}
 */
function themesDir(home) {
  return path.join(home, '.tmd', 'themes')
}

/**
 * 判断裸文件名是否为可收录的主题文件：
 * 非空主名、非隐藏、不含任何路径分隔符、以 .css 结尾（大小写不敏感）。
 * 只接受 readdir 得到的裸文件名，不接受路径片段。
 * @param {unknown} name
 * @returns {boolean}
 */
function isThemeFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 4 && // 至少 1 个字符的主名 + 「.css」
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    path.basename(name) === name &&
    THEME_EXT_RE.test(name)
  )
}

/**
 * 读取前的文件名安全校验：防路径穿越（../../etc/passwd、绝对路径、分隔符注入）。
 * @param {unknown} name
 * @returns {string | null} 通过校验返回原文件名，否则 null
 */
function safeThemeName(name) {
  return isThemeFileName(name) && typeof name === 'string' ? name : null
}

/**
 * 主题显示名：去掉 .css 扩展名。
 * @param {string} fileName
 * @returns {string}
 */
function themeDisplayName(fileName) {
  return fileName.replace(THEME_EXT_RE, '')
}

/**
 * 扫描主题目录：返回主题条目数组（name 为裸文件名），按给定区域排序。
 * 目录不存在或不可读时返回空数组——不主动创建目录（凭空在用户主目录建
 * 文件夹是副作用，创建只发生在用户显式点「打开主题文件夹」时）。
 * @param {string} dir - 主题目录绝对路径
 * @param {string} [locale] - 排序区域（跟随界面语言，与文件树排序同源）
 * @returns {Promise<{name: string}[]>}
 */
async function listThemeFiles(dir, locale) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && isThemeFileName(entry.name))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
}

/**
 * 读取主题文件内容（UTF-8）。
 * @param {string} dir - 主题目录绝对路径
 * @param {unknown} name - 裸文件名（经 safeThemeName 校验）
 * @returns {Promise<string | null>} CSS 文本；文件名非法 / 不存在 / 超上限时返回 null
 */
async function readThemeFile(dir, name) {
  const safe = safeThemeName(name)
  if (!safe) return null
  const full = path.join(dir, safe)
  // 二次防线：join 结果必须仍直接位于主题目录内
  if (path.dirname(full) !== path.resolve(dir)) return null
  try {
    const stat = await fs.stat(full)
    if (!stat.isFile() || stat.size > THEME_MAX_SIZE) return null
    return await fs.readFile(full, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 首次打开主题文件夹时写入的示例主题：列出全部可覆盖变量的浅色/深色两块，
 * 用户照抄改即可；不想要可自行删除（删空后下次打开文件夹不会再写回——
 * 仅在目录中一个 .css 都没有时才写入，避免覆盖用户清场意图）。
 */
const SAMPLE_THEME_CSS = `/**
 * TMD 自定义主题示例
 *
 * 规则：
 * 1. 本文件名去掉 .css 就是设置面板里显示的主题名（支持中文），重命名文件即改名
 * 2. 只需写想覆盖的变量，未列出的变量自动沿用内置值
 * 3. 浅色外观写在 :root 下；深色外观写在 html.dark 下（工具栏月亮按钮切换深浅）
 * 4. 除变量外也可写任意 CSS 选择器，本文件内容会原样注入应用
 * 5. 在外部编辑器修改并保存后，到设置面板点「刷新」即生效
 */

/* 浅色模式（默认） */
:root {
  --bg: #faf8f5;                     /* 界面与编辑区背景 */
  --fg: #333333;                     /* 正文文字 */
  --muted: #888888;                  /* 次要文字 */
  --border: #e5e0d8;                 /* 边框 / 分隔线 */
  --accent: #c17f59;                 /* 强调色（链接、选中态） */
  --code-bg: #f3efe8;                /* 行内代码背景 */
  --pre-bg: #f0ebe2;                 /* 代码块背景 */
  --quote-bg: transparent;           /* 引用块背景 */
  --toolbar-bg: rgba(250, 248, 245, 0.85); /* 工具栏背景 */
  --error-fg: #d1242f;               /* 错误文字 */
  --error-bg: #fff1f0;               /* 错误背景 */
}

/* 深色模式（可选：整块删掉则深色下沿用内置深色变量） */
html.dark {
  --bg: #262320;
  --fg: #e0dbd3;
  --muted: #9a9388;
  --border: #44403a;
  --accent: #d49a6a;
  --code-bg: #33302b;
  --pre-bg: #2e2b27;
  --quote-bg: transparent;
  --toolbar-bg: rgba(38, 35, 32, 0.85);
  --error-fg: #f97583;
  --error-bg: #3a2426;
}
`

/** 示例主题的文件名（中文，文件名即主题显示名） */
const SAMPLE_THEME_FILE = '示例主题.css'

/**
 * 确保主题目录存在；目录中尚无任何 .css 文件时写入示例主题。
 * @param {string} dir - 主题目录绝对路径
 * @returns {Promise<{sampleWritten: boolean}>}
 */
async function ensureThemesDirWithSample(dir) {
  await fs.mkdir(dir, { recursive: true })
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const hasCss = entries.some((entry) => entry.isFile() && isThemeFileName(entry.name))
  if (hasCss) return { sampleWritten: false }
  // wx 兜底：极端竞态下（外部同时写入）不覆盖已有文件
  await fs.writeFile(path.join(dir, SAMPLE_THEME_FILE), SAMPLE_THEME_CSS, {
    encoding: 'utf-8',
    flag: 'wx',
  })
  return { sampleWritten: true }
}

module.exports = {
  themesDir,
  isThemeFileName,
  safeThemeName,
  themeDisplayName,
  listThemeFiles,
  readThemeFile,
  ensureThemesDirWithSample,
  SAMPLE_THEME_CSS,
  SAMPLE_THEME_FILE,
  THEME_MAX_SIZE,
}
