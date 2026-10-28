/**
 * 生成 Tauri 更新器元数据 latest.json（发版用，见 docs/打包发布.md §11.3）。
 *
 * 输入：带签名构建（dist:tauri:*:signed）产出的安装包与其 .sig 文件。
 * 输出：releases/latest.json——两个平台条目（windows-x86_64 / darwin-aarch64），
 *       signature 字段为 .sig 文件的**文本内容**（minisign 签名，非 base64 再编码），
 *       url 指向 Gitee Release 附件的绝对地址（与 Electron 元数据同口径：
 *       Tauri 更新器对绝对 URL 原样使用，不做 baseUrl 拼接）。
 *
 * 双源策略与 Electron 版一致：Gitee 为主源（latest.json 经 git 推到
 * releases/，见 release.yml 的元数据推送步骤），GitHub Release 同传一份作备用端点。
 *
 * 用法：
 *   node scripts/make-tauri-latest.mjs \
 *     --win-setup  src-tauri/target/release/bundle/nsis/TMD_x.y.z_x64-setup.exe \
 *     --win-sig    同名.exe.sig \
 *     --mac-dmg    src-tauri/target/release/bundle/dmg/TMD_x.y.z_aarch64.dmg \
 *     --mac-sig    updater 产物 .sig（mac 为 TMD.app.tar.gz.sig） \
 *     --mac-url-name TMD.app.tar.gz \
 *     --tag v0.2.0
 *   省略 --mac-* 时只生成 windows 条目（本地单平台验证常见）。
 *   产物落 dist-tauri/latest.json；--out 可覆盖。
 *
 * @author chiangyang
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

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
 * 组装单平台条目（纯函数，供单测）。
 * @param {{ url: string, signature: string }} p
 */
export function platformEntry({ url, signature }) {
  return {
    signature,
    url,
  }
}

/** 发布版本号：tag（v0.2.0 → 0.2.0）优先，回落 package.json version */
function versionOf(tag) {
  if (tag) return tag.replace(/^v/, '')
  return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = versionOf(args.tag)
  const outPath = resolve(args.out ?? join(REPO, 'dist-tauri', 'latest.json'))

  /** Gitee Release 附件绝对地址（与 Electron 元数据 absolutize 同口径） */
  const giteeUrl = (name) =>
    `https://gitee.com/chiangyangNPU/tmd/releases/download/${args.tag ?? `v${version}`}/${name}`

  const platforms = {}

  if (args['win-setup']) {
    const sigPath = args['win-sig'] ?? `${args['win-setup']}.sig`
    if (!existsSync(sigPath)) {
      console.error(`::error::缺少签名文件: ${sigPath}`)
      process.exit(1)
    }
    const name = basenameOf(args['win-setup'])
    platforms['windows-x86_64'] = platformEntry({
      url: giteeUrl(name),
      signature: readText(sigPath),
    })
  }

  if (args['mac-sig']) {
    const name = args['mac-url-name'] ?? 'TMD.app.tar.gz'
    platforms['darwin-aarch64'] = platformEntry({
      url: giteeUrl(name),
      signature: readText(args['mac-sig']),
    })
  }

  if (!Object.keys(platforms).length) {
    console.error(
      '::error::没有可写入的平台条目。至少提供 --win-setup（自动找同名 .sig）或 --mac-sig',
    )
    process.exit(1)
  }

  const latest = {
    version,
    notes: args.notes ?? '',
    pub_date: new Date().toISOString(),
    platforms,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(latest, null, 2) + '\n')
  console.log(`[make-tauri-latest] ${outPath}`)
  console.log(JSON.stringify(latest, null, 2))
}

function readText(p) {
  const text = readFileSync(p, 'utf8').trim()
  if (!text) throw new Error(`签名文件为空: ${p}`)
  return text
}
function basenameOf(p) {
  return p.replaceAll('\\', '/').split('/').pop()
}

main()
