#!/usr/bin/env node
/**
 * 生成发布到 Gitee 所需的元数据与待上传清单（方案 C：Gitee 手动发布）。
 *
 * 背景（为什么 Gitee 不走 CI，详见 docs/打包发布.md §9）：
 * - GitHub Actions runner 在海外，到 Gitee 的跨国链路传输 170MB 附件需 1 小时以上
 *   （本地网络仅分钟级）；Gitee 对海外 IP 的 contents API 另有 405 反爬拦截
 * - CI 直推 Gitee master 会造成仓库分叉（远程多出元数据提交，本地 push 被拒）
 *
 * 本脚本做三件事：
 * 1. 从 GitHub Release（公开 API，无需 token）下载 latest*.yml——**必须用 CI 的
 *    元数据**：本地打包的安装包与 CI 构建的二进制不同、sha512 也不同，只有
 *    CI 的元数据与用户从 Gitee 下载到的产物匹配
 * 2. 把 yml 的 url / path 由「文件名」改为 Gitee Release 附件的**绝对 URL**
 *    （`{repo}/releases/download/{tag}/{文件名}`）——应用内置的 generic 更新源
 *    只按 baseUrl 拼接相对路径，若仍是文件名，更新器会去 raw 目录找安装包而
 *    404（安装包在 Release 附件区）；绝对 URL 会被直接使用
 * 3. 元数据写入仓库 releases/（随 pushall 同步双端，无需 CI 推送，也就不存在
 *    master 分叉），并打印需在 Gitee Release 手动上传的文件清单
 *
 * 用法：
 * - `npm run release:gitee`：从 GitHub Release 拉取元数据（本地手动发布用）
 * - `node scripts/prepare-gitee-release.mjs --local`：直接读本地 release/ 目录
 *   （CI 里用——彼时 Release 刚创建，产物就在工作目录，无需绕道 GitHub）
 *
 * @author chiangyang
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const META_DIR = 'releases'
const RELEASE_DIR = 'release'

/**
 * 把 yml 中的 `- url: <文件名>` 与顶层 `path: <文件名>` 替换为绝对下载 URL。
 * 纯函数（供单测）：直接使用绝对 URL 是 electron-updater 的通用约定——
 * 已是绝对地址时 new URL(value, baseUrl) 会原样返回，不再拼接 baseUrl。
 * @param {string} ymlText electron-builder 生成的 latest*.yml 全文
 * @param {(name: string) => string} toAbsolute 文件名 → 绝对 URL
 */
export function absolutizeYmlUrls(ymlText, toAbsolute) {
  // 已是绝对 URL 的值原样保留（幂等：重复运行不会把 URL 再包一层）
  /** @param {string} name @returns {string} */
  const convert = (name) => (name.startsWith('http') ? name : toAbsolute(name))
  return ymlText
    .replace(/^(\s*- url: )(.+)$/gm, (_m, prefix, name) => prefix + convert(name.trim()))
    .replace(/^(path: )(.+)$/gm, (_m, prefix, name) => prefix + convert(name.trim()))
}

/**
 * 从 package.json 的发布源配置提取 Gitee 与 GitHub 的 owner/repo
 * @param {{ build: { publish: Array<{ provider: string, url?: string, owner?: string, repo?: string }> } }} pkg
 */
function reposOf(pkg) {
  const generic = pkg.build.publish.find((p) => p.provider === 'generic')
  const github = pkg.build.publish.find((p) => p.provider === 'github')
  const m = generic?.url?.match(/gitee\.com\/([^/]+)\/([^/]+)\//)
  if (!m || !github?.owner || !github.repo) {
    throw new Error('package.json 发布源配置不完整（需 generic.url 与 github.owner/repo）')
  }
  return { gitee: { owner: m[1], repo: m[2] }, github: { owner: github.owner, repo: github.repo } }
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
  /** @param {string} name @returns {string} */
  const toAbsolute = (name) =>
    `https://gitee.com/${repos.gitee.owner}/${repos.gitee.repo}/releases/download/${tag}/${name}`

  /** @type {Array<{ name: string, url: string, size: number }>} */
  let assets
  /** @type {Array<{ name: string, text: string }>} */
  let ymls
  if (localMode) {
    // CI 模式：产物就在本地 release/（刚构建完），无需绕道 GitHub
    const names = readdirSync(RELEASE_DIR)
    assets = names.map((name) => ({ name, url: '', size: statSync(path.join(RELEASE_DIR, name)).size }))
    ymls = names
      .filter((n) => /^latest.*\.yml$/.test(n))
      .map((name) => ({ name, text: readFileSync(path.join(RELEASE_DIR, name), 'utf8') }))
  } else {
    // assets 清单走 GitHub API（api.github.com 可达性好）；
    // yml 内容优先取 Gitee 仓库 releases/（CI 推送的权威副本，国内直连快）——
    // GitHub 的下载域名（github.com/.../releases/download/）在国内常不可达。
    // 用 version 字段校验取自 Gitee 的确实是当前版本，不匹配则回退 GitHub
    assets = await fetchReleaseAssets(repos.github, tag)
    const names = assets.filter((a) => /^latest.*\.yml$/.test(a.name)).map((a) => a.name)
    if (!names.length) throw new Error(`${tag} 的 GitHub Release 中没有 latest*.yml`)
    ymls = []
    for (const name of names) {
      const giteeUrl = `https://gitee.com/${repos.gitee.owner}/${repos.gitee.repo}/raw/master/releases/${name}`
      const fromGitee = curlGet(giteeUrl)
      if (fromGitee.status === 200 && fromGitee.body.includes(`version: ${pkg.version}`)) {
        ymls.push({ name, text: fromGitee.body })
        console.log(`（${name} 取自 Gitee raw）`)
        continue
      }
      const asset = assets.find((a) => a.name === name)
      if (!asset) throw new Error(`GitHub Release 中找不到 ${name} 的下载地址`)
      const fromGithub = curlGet(asset.url)
      if (fromGithub.status !== 200) {
        throw new Error(
          `下载 ${name} 失败（Gitee ${fromGitee.status}、GitHub ${fromGithub.status}）——` +
            '可手动从 GitHub Release 页面下载该文件到 release/ 目录后重试',
        )
      }
      ymls.push({ name, text: fromGithub.body })
      console.log(`（${name} 取自 GitHub Release）`)
    }
  }
  if (!ymls.length) throw new Error(`${tag} 没有 latest*.yml 元数据`)

  mkdirSync(META_DIR, { recursive: true })
  for (const yml of ymls) {
    const patched = absolutizeYmlUrls(yml.text, toAbsolute)
    if (!patched.includes('https://gitee.com/')) {
      throw new Error(`${yml.name} 中未发现可替换的 url 字段，格式可能已变化，请检查`)
    }
    writeFileSync(path.join(META_DIR, yml.name), patched)
    console.log(`元数据已生成：${META_DIR}/${yml.name}（url 绝对化 → ${tag}）`)
  }

  if (localMode) return // CI 模式：无需打印手动上传指引

  // 待上传清单：安装包与差量索引（元数据走 git 提交，不作为 Release 附件）
  const uploads = assets.filter((a) => /\.(dmg|exe|blockmap)$/.test(a.name))
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
