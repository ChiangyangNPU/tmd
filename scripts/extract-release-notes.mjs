/**
 * 从 CHANGELOG.md 提取「当前版本」的更新说明，写入 .release-notes.md。
 *
 * 为什么不直接用 CHANGELOG.md 当 releaseNotesFile：electron-builder 会把
 * 整份文件（含 [未发布] 与全部历史版本）塞进 latest*.yml 的 releaseNotes，
 * 用户在更新弹窗里看到的是错乱的说明。
 *
 * 规则（版本号取自 package.json）：
 * - CHANGELOG.md 存在 `## [x.y.z]` 小节 → 提取该节（到下一个 `## ` 为止）
 * - 缺失但存在 `## [未发布]` → 用未发布节并告警（日常本地构建的宽容路径）
 * - 两者皆无 → 报错退出
 *
 * Windows 注意：CI 的 git checkout 会把文本转成 CRLF，切分必须用 /\r?\n/
 * （JS 正则的 . 不匹配 \r、$ 不锚定 \r 前，按 \n 切会在 Windows 解析出空表）。
 *
 * @author chiangyang
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const CHANGELOG = 'CHANGELOG.md'
const OUTPUT = '.release-notes.md'
const HEADING_RE = /^## \[(.+?)\].*$/

/**
 * 按 `## [标题]` 切分 CHANGELOG，返回 Map<title, 节全文（含标题行）>。
 * @param {string} markdown
 */
export function parseSections(markdown) {
  const lines = markdown.split(/\r?\n/)
  const sections = new Map()
  let current = null
  for (const line of lines) {
    const m = line.match(HEADING_RE)
    if (m) {
      current = m[1]
      sections.set(current, [line])
    } else if (current) {
      sections.get(current).push(line)
    }
  }
  return new Map([...sections].map(([k, v]) => [k, v.join('\n').trimEnd()]))
}

function main() {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const sections = parseSections(readFileSync(CHANGELOG, 'utf8'))
  const strict = process.argv.includes('--strict')

  if (sections.has(version)) {
    writeFileSync(OUTPUT, sections.get(version) + '\n')
    console.log(
      `release notes ← CHANGELOG [${version}]（${sections.get(version).split('\n').length} 行）`,
    )
  } else if (sections.has('未发布') && !strict) {
    writeFileSync(OUTPUT, sections.get('未发布') + '\n')
    console.warn(
      `警告：CHANGELOG 缺少 [${version}] 小节，release notes 回退用 [未发布]（发版前须转正，见 docs/打包发布.md §3）`,
    )
  } else {
    console.error(
      strict
        ? `CHANGELOG.md 缺少 [${version}] 小节：发版前请把 [未发布] 转正为 [${version}]（docs/打包发布.md §3）`
        : `CHANGELOG.md 既无 [${version}] 也无 [未发布] 小节，无法生成 release notes`,
    )
    process.exit(1)
  }
}

// 被 node 直接执行时跑主流程；被测试 import 时不执行
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
