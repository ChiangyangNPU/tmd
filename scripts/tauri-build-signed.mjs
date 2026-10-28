/**
 * 带更新签名的发版构建（Windows NSIS）。
 *
 * 为什么要包装一层：`bundle.createUpdaterArtifacts` 打开后，Tauri 在缺少签名
 * 私钥时会直接让构建失败——所以签名产物不能放在基础 tauri.conf.json 里，
 * 否则日常 `npm run dist:tauri:win` 会被迫先配私钥。本脚本的做法：
 *
 *   1. 叠加 src-tauri/tauri.updater.conf.json（只把 createUpdaterArtifacts 置真）
 *   2. 把私钥路径注入 TAURI_SIGNING_PRIVATE_KEY（build/bundle 命令接受路径）
 *   3. 密码存在时注入 TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 *
 * 私钥解析顺序：
 *   $TAURI_SIGNING_PRIVATE_KEY（已是内容或路径，直接透传）
 *   → $TMD_UPDATER_KEY_PATH
 *   → ~/.tauri/tmd-updater.key（tauri signer generate 的默认落点）
 *
 * 用法：
 *   npm run dist:tauri:win:signed            # Windows NSIS + .sig
 *   npm run dist:tauri:mac:signed            # macOS dmg + updater 包 + .sig
 *   node scripts/tauri-build-signed.mjs -- --bundles nsis   # 自定义参数
 *
 * @author chiangyang
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const OVERLAY = join('src-tauri', 'tauri.updater.conf.json')

function resolvePrivateKey() {
  const fromEnv = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()
  if (fromEnv) return fromEnv
  const fromEnvPath = process.env.TMD_UPDATER_KEY_PATH?.trim()
  if (fromEnvPath && existsSync(fromEnvPath)) return fromEnvPath
  const fallback = join(homedir(), '.tauri', 'tmd-updater.key')
  if (existsSync(fallback)) return fallback
  return null
}

const key = resolvePrivateKey()
if (!key) {
  console.error(
    '[tauri-build-signed] 找不到签名私钥。任选其一：\n' +
      '  1) 先生成：npm run tauri signer generate -- -w ~/.tauri/tmd-updater.key\n' +
      '  2) 显式指定：TMD_UPDATER_KEY_PATH=<私钥路径> npm run dist:tauri:win:signed\n' +
      '  3) CI：注入 Secret 到 TAURI_SIGNING_PRIVATE_KEY',
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const passThrough = args[0] === '--' ? args.slice(1) : args
const bundleArgs = passThrough.length ? passThrough : ['--bundles', 'nsis']

console.log(`[tauri-build-signed] 私钥: ${key.includes('\n') ? '(来自环境变量内容)' : key}`)
console.log(`[tauri-build-signed] tauri build ${bundleArgs.join(' ')} --config ${OVERLAY}`)

const result = spawnSync(
  'npx',
  ['tauri', 'build', ...bundleArgs, '--config', OVERLAY],
  {
    cwd: REPO,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key },
  },
)
process.exit(result.status ?? 1)
