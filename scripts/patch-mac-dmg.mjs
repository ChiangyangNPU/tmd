/**
 * mac dmg 后处理：UDBZ/UDZO → ULMO（lzfse）压缩 + 更新元数据一致性修补。
 *
 * 为什么：Gitee Release 附件单文件上限 100MB，`compression: maximum` 下
 * electron-builder 产出的 UDBZ dmg 约 102.8MB 被服务端拒绝；实测转 ULMO 后
 * 约 85MB（-17%）。electron-builder 的 dmg.format 配置只放行 ULFO（实测
 * 110.32MB，反而更大——schema 枚举没有 ULMO），afterAllArtifactBuild 钩子
 * 又与 --publish always 的异步上传队列存在竞态，故放在构建完成后、任何
 * 上传之前执行（CI 里 mac job 在 --publish never 构建后调用本脚本）。
 *
 * 做三件事：
 * 1. release/*.dmg 逐个转 ULMO（临时文件生成后原子替换）
 * 2. latest-mac.yml 的 sha512 / size 按新文件重算（electron-updater 校验依据）
 * 3. 删除过期 dmg blockmap——blockmap 描述的是转换前文件的分块哈希，与新
 *    文件不匹配会让差量下载拼出坏文件；删除后 electron-updater 对 404 回退
 *    全量下载（mac 未签名场景自动更新本就无法完成安装，待签名落地时连同
 *    差量更新一起重新评估）
 *
 * 仅 macOS 可运行（依赖 hdiutil），非 darwin 直接返回（Windows job 不受影响）。
 *
 * @author chiangyang
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT_DIR = 'release'

/** 计算文件 sha512（base64，与 electron-builder 写入 latest-mac.yml 的格式一致） */
/** @param {string} filePath */
function sha512File(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

/**
 * 修补 update 元数据 YAML：把 url 匹配条目及顶层同名引用的 sha512/size 替换
 * 为新值。纯函数（供单测）；条目不存在时抛错——元数据与产物不一致会直接
 * 破坏自动更新校验，宁可失败也不静默跳过。
 *
 * @param {string} yamlText electron-builder 生成的 latest-*.yml 全文
 * @param {string} filename 产物文件名（如 TMD-0.1.0-arm64.dmg）
 * @param {{ sha512: string, size: number }} patch 新的 sha512（base64）与字节数
 * @returns {string} 修补后的 YAML 全文
 */
export function patchUpdateYml(yamlText, filename, patch) {
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // files[] 条目：- url: <名> / sha512: <旧> / size: <旧>
  const entryRe = new RegExp(`- url: ${esc}\\n(\\s+sha512: )[^\\n]+\\n(\\s+size: )\\d+`)
  if (!entryRe.test(yamlText)) {
    throw new Error(`update yml 中找不到 ${filename} 的更新条目，拒绝产出不一致的元数据`)
  }
  let out = yamlText.replace(
    entryRe,
    (_m, shaKey, sizeKey) =>
      `- url: ${filename}\n${shaKey}${patch.sha512}\n${sizeKey}${patch.size}`,
  )
  // 顶层引用：path: <名> 后紧跟的 sha512 行（mac 元数据顶层没有 size 行——
  // size 只在 files 条目里；若未来格式出现顶层 size 也一并修补）
  const topRe = new RegExp(`(path: ${esc}\\nsha512: )[^\\n]+(\\nsize: )?\\d*`)
  out = out.replace(topRe, (_m, head, sizeKey) =>
    sizeKey !== undefined
      ? `${head}${patch.sha512}${sizeKey}${patch.size}`
      : `${head}${patch.sha512}`,
  )
  return out
}

/** 查找输出目录里 latest-mac.yml 登记的 dmg 产物（跳过 hdiutil 残留的隐藏临时文件） */
function findDmgs() {
  const yml = readFileSync(path.join(OUTPUT_DIR, 'latest-mac.yml'), 'utf8')
  return readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.dmg') && !f.startsWith('.'))
    .filter((f) => yml.includes(`url: ${f}`))
    .map((f) => path.join(OUTPUT_DIR, f))
}

/** 对单个 dmg 执行转换替换，返回转换前后字节数与新 sha512 */
/** @param {string} dmgPath */
function convertToUlmo(dmgPath) {
  const tmp = path.join(OUTPUT_DIR, `.tmp-ulmo-${path.basename(dmgPath)}`)
  rmSync(tmp, { force: true })
  execFileSync('hdiutil', ['convert', dmgPath, '-format', 'ULMO', '-o', tmp], { stdio: 'inherit' })
  const before = statSync(dmgPath).size
  renameSync(tmp, dmgPath)
  const after = statSync(dmgPath).size
  return { before, after, sha512: sha512File(dmgPath) }
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('非 macOS 环境，跳过 dmg 后处理')
    return
  }
  const dmgs = findDmgs()
  if (!dmgs.length) {
    throw new Error(`${OUTPUT_DIR} 下没有找到 latest-mac.yml 登记的 dmg 产物`)
  }
  for (const dmg of dmgs) {
    const name = path.basename(dmg)
    const { before, after, sha512 } = convertToUlmo(dmg)
    console.log(`${name}: ${(before / 1e6).toFixed(1)}MB → ${(after / 1e6).toFixed(1)}MB (ULMO)`)

    const ymlPath = path.join(OUTPUT_DIR, 'latest-mac.yml')
    writeFileSync(
      ymlPath,
      patchUpdateYml(readFileSync(ymlPath, 'utf8'), name, { sha512, size: after }),
    )

    const staleBlockmap = dmg.replace(/\.dmg$/, '.dmg.blockmap')
    rmSync(staleBlockmap, { force: true })
    console.log(
      `latest-mac.yml 已按新文件重算；过期 blockmap 已移除（${path.basename(staleBlockmap)}）`,
    )
  }
}

// 被 node 直接执行时跑主流程；被测试 import 时不执行
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
