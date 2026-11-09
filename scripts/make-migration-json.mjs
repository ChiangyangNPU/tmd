/**
 * 生成架构迁移提示元数据 migration.json（发版用，见 docs/打包发布.md §12）。
 *
 * 与 latest.yml（Electron 更新源）/ latest.json（Tauri 更新源）并列放在
 * releases/ 与 Release 附件里：Electron 版检查更新时读取它，命中更高版本
 * 即弹原生对话框引导老用户手动下载新架构安装包（跨架构无法自动升级）。
 *
 * **迁移开关**：文件存在 = 开关打开；不存在 = 关闭。发布工作流里由
 * MIGRATION_TARGET 变量控制是否调用本脚本（空值即跳过）。
 *
 * 用法：
 *   node scripts/make-migration-json.mjs \
 *     --version 0.2.0 \
 *     --mac-dmg  TMD_0.2.0_aarch64.dmg \
 *     --win-setup TMD_0.2.0_x64-setup.exe \
 *     [--notes "自定义提示文案"] [--tag v0.2.0] [--out dist-tauri/migration.json]
 *
 * 下载地址与 Electron 元数据同口径：Gitee Release 附件绝对地址
 * （https://gitee.com/{owner}/{repo}/releases/download/{tag}/{name}）。
 *
 * @author chiangyang
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const OWNER = 'chiangyangNPU'
const REPO_NAME = 'tmd'

/** 解析 --key value 形式的命令行参数 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? ''
    else out._.push(argv[i])
  }
  return out
}

/**
 * Gitee Release 附件绝对地址（与 Electron latest.yml 的 absolutize 同口径）。
 * @param {string} tag
 * @param {string} name
 */
export function giteeAssetUrl(tag, name) {
  return `https://gitee.com/${OWNER}/${REPO_NAME}/releases/download/${tag}/${name}`
}

/**
 * 组装迁移元数据（纯函数，供单测）。
 * @param {{ version: string, tag: string, macDmg?: string, winSetup?: string, notes?: string }} p
 * @returns {{ version: string, notes: string, downloads: { darwin?: string, win32?: string } }}
 */
export function buildMigrationInfo({ version, tag, macDmg, winSetup, notes }) {
  /** @type {{ darwin?: string, win32?: string }} */
  const downloads = {}
  if (macDmg) downloads.darwin = giteeAssetUrl(tag, macDmg)
  if (winSetup) downloads.win32 = giteeAssetUrl(tag, winSetup)
  return {
    version,
    notes:
      notes ||
      '新架构安装包体积约 6MB（原约 290MB），启动更快、空闲内存更省。' +
        '跨架构无法自动升级，需手动下载安装一次；文档、历史版本、AI 配置等全部保留。',
    downloads,
  }
}

function basenameOf(p) {
  return p.replaceAll('\\', '/').split('/').pop()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = String(args.version || '').replace(/^v/, '').trim()
  if (!version) {
    console.error('::error::缺少 --version（迁移目标版本，如 0.2.0）')
    process.exit(1)
  }
  const tag = args.tag || `v${version}`
  const info = buildMigrationInfo({
    version,
    tag,
    macDmg: args['mac-dmg'] ? basenameOf(args['mac-dmg']) : undefined,
    winSetup: args['win-setup'] ? basenameOf(args['win-setup']) : undefined,
    notes: args.notes || undefined,
  })
  if (!info.downloads.darwin && !info.downloads.win32) {
    console.error('::error::至少提供 --mac-dmg 或 --win-setup')
    process.exit(1)
  }
  const outPath = resolve(args.out ?? `${REPO}/dist-tauri/migration.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n')
  console.log(`[make-migration-json] ${outPath}`)
  console.log(JSON.stringify(info, null, 2))
}

// 仅直接执行时走 CLI（被单测 import 时只暴露纯函数）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
