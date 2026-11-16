/**
 * 生成发布到 Gitee 所需的 Tauri 元数据与待上传清单（本地补发通道）。
 *
 * 背景（为什么保留本地通道，详见 docs/打包发布.md §9）：
 * - GitHub Actions runner 在海外，到 Gitee 的跨国链路可能过慢或超时
 * - CI 直推 Gitee master 会产生一个元数据提交，本地需合并后再同步双端
 *
 * 本脚本做三件事：
 * 1. 从 GitHub Release（公开 API，无需 token）取得当前版本的 latest.json 与
 *    migration.json——必须使用 CI 生成并签名的产物元数据，不能用本地打包结果替代
 * 2. 校验版本及 Tauri 双平台条目后写入 releases/；Electron 0.1.x 迁移用的
 *    latest.yml / latest-mac.yml 已冻结，本脚本绝不改写
 * 3. 打印需在 Gitee Release 手动上传的 Tauri 产物清单
 *
 * 用法：
 * - `npm run release:gitee`：从 GitHub Release 拉取元数据（本地手动发布用）
 * - `node scripts/prepare-gitee-release.mjs --local`：直接读本地 release/ 目录
 *
 * @author chiangyang
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const META_DIR = 'releases'
const RELEASE_DIR = 'release'
const META_NAMES = ['latest.json', 'migration.json']
const TAURI_PLATFORMS = ['windows-x86_64', 'darwin-aarch64']

/**
 * 解析并校验一份版本化发布元数据。
 * latest.json 还必须包含 Tauri 双平台的下载地址与非空签名，避免补发残缺更新链。
 * @param {string} name 元数据文件名
 * @param {string} text JSON 全文
 * @param {string} expectedVersion 当前 package.json 版本（不带 v）
 */
export function parseMetadata(name, text, expectedVersion) {
  /** @type {any} */
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${name} 不是有效 JSON`)
  }
  if (data?.version !== expectedVersion) {
    throw new Error(
      `${name} 版本 ${data?.version ?? '(缺失)'} 与当前版本 ${expectedVersion} 不一致`,
    )
  }
  if (name === 'latest.json') {
    for (const platform of TAURI_PLATFORMS) {
      const entry = data.platforms?.[platform]
      if (!entry?.url || !entry?.signature) {
        throw new Error(`${name} 缺少 ${platform} 的下载地址或签名`)
      }
    }
  }
  return data
}

/**
 * 只写 Tauri JSON 元数据；同目录冻结的 Electron YML 不在写入集合内。
 * 独立导出供单测验证冻结文件逐字节不变。
 * @param {string} metaDir 元数据目录
 * @param {Record<string, string>} metadata 文件名 → JSON 全文
 */
export function writeMetadataFiles(metaDir, metadata) {
  mkdirSync(metaDir, { recursive: true })
  for (const name of META_NAMES) {
    writeFileSync(path.join(metaDir, name), metadata[name])
  }
}

/**
 * 从 package.json 顶层 releasePublish 提取 Gitee 与 GitHub 的 owner/repo。
 * @param {{ releasePublish?: { gitee?: string, github?: { owner?: string, repo?: string } } }} pkg
 */
function reposOf(pkg) {
  const rp = pkg.releasePublish
  const m = rp?.gitee?.match(/gitee\.com\/([^/]+)\/([^/]+)/)
  if (!m || !rp?.github?.owner || !rp.github.repo) {
    throw new Error(
      'package.json 发布源配置不完整（需 releasePublish.gitee 与 releasePublish.github.owner/repo）',
    )
  }
  return {
    gitee: { owner: m[1], repo: m[2] },
    github: { owner: rp.github.owner, repo: rp.github.repo },
  }
}

/**
 * 用 curl 发起 GET（Node 内置 fetch 不读系统/环境代理，国内直连 GitHub 常失败；
 * curl 尊重 http_proxy 等配置，且 macOS / Windows 10+ 均自带）。
 * @param {string} url
 * @returns {{ status: number, body: string }} HTTP 状态码与响应体
 */
function curlGet(url) {
  const out = execFileSync('curl', ['-sL', '--max-time', '120', '-w', '\n%{http_code}', url], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const idx = out.lastIndexOf('\n')
  return { status: Number(out.slice(idx + 1)), body: out.slice(0, idx) }
}

/**
 * 取 GitHub Release 的 assets 列表（公开 API，未认证限 60 次/小时，本脚本仅调用一次）
 * @param {{ owner: string, repo: string }} repoRef
 * @param {string} tag
 */
async function fetchReleaseAssets({ owner, repo }, tag) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
  const { status, body } = curlGet(url)
  if (status !== 200) {
    throw new Error(
      `拉取 GitHub Release 失败（HTTP ${status}）：${url}\n` +
        '请确认该 tag 的 Release 已发布（非草稿）且本机可访问 GitHub',
    )
  }
  /** @type {{ assets: Array<{ name: string, browser_download_url: string, size: number }> }} */
  const data = JSON.parse(body)
  return data.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
}

async function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const repos = reposOf(pkg)
  const tag = `v${pkg.version}`
  const localMode = process.argv.includes('--local')
  /** @type {Array<{ name: string, url: string, size: number }>} */
  let assets
  /** @type {Record<string, string>} */
  const metadata = {}

  if (localMode) {
    const names = readdirSync(RELEASE_DIR)
    assets = names.map((name) => ({
      name,
      url: '',
      size: statSync(path.join(RELEASE_DIR, name)).size,
    }))
    for (const name of META_NAMES) {
      const text = readFileSync(path.join(RELEASE_DIR, name), 'utf8')
      parseMetadata(name, text, pkg.version)
      metadata[name] = text
    }
  } else {
    assets = await fetchReleaseAssets(repos.github, tag)
    for (const name of META_NAMES) {
      const asset = assets.find((a) => a.name === name)
      if (!asset) throw new Error(`${tag} 的 GitHub Release 中没有 ${name}`)

      // 优先读 Gitee raw 的权威副本（国内直连通常更稳定）；版本或内容不符合
      // 当前发布时回退 GitHub Release，不能把上一版元数据写入本次发布。
      const giteeUrl = `https://gitee.com/${repos.gitee.owner}/${repos.gitee.repo}/raw/master/releases/${name}`
      const fromGitee = curlGet(giteeUrl)
      if (fromGitee.status === 200) {
        try {
          parseMetadata(name, fromGitee.body, pkg.version)
          metadata[name] = fromGitee.body
          console.log(`（${name} 取自 Gitee raw）`)
          continue
        } catch {
          console.log(`（Gitee raw 的 ${name} 不是当前完整版本，改取 GitHub Release）`)
        }
      }

      const fromGithub = curlGet(asset.url)
      if (fromGithub.status !== 200) {
        throw new Error(
          `下载 ${name} 失败（Gitee ${fromGitee.status}、GitHub ${fromGithub.status}）——` +
            '可手动从 GitHub Release 页面下载该文件到 release/ 目录后重试',
        )
      }
      parseMetadata(name, fromGithub.body, pkg.version)
      metadata[name] = fromGithub.body
      console.log(`（${name} 取自 GitHub Release）`)
    }
  }

  writeMetadataFiles(META_DIR, metadata)
  for (const name of META_NAMES) console.log(`元数据已生成：${META_DIR}/${name}`)
  console.log('冻结迁移元数据保持不动：releases/latest.yml、releases/latest-mac.yml')

  if (localMode) return

  // 与 CI 的 Gitee 上传集合一致：Tauri 安装包、updater 包、签名及 latest.json。
  // migration.json 经 git 提交到 raw 端点；冻结 YML 既不更新也不需要手动上传。
  const uploads = assets.filter((a) => /\.(dmg|exe|sig|app\.tar\.gz)$|^latest\.json$/.test(a.name))
  console.log(`\n请到 Gitee 创建 Release（标签 ${tag}）并上传以下 ${uploads.length} 个文件：`)
  for (const a of uploads) {
    console.log(`  · ${a.name}（${(a.size / 1e6).toFixed(1)}MB）`)
  }
  console.log(
    `\n随后提交元数据并同步双端：\n` +
      `  git add ${META_DIR}/ && git commit -m "chore: update release metadata for ${tag}" && git pushall`,
  )
}

// 被 node 直接执行时跑主流程；被测试 import 时不执行
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
