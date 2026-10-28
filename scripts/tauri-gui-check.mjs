/**
 * Tauri 版 GUI 冒烟（Windows / WebView2 CDP）。
 *
 * 背景：Electron 版用 `--remote-debugging-port` + CDP 做桌面自动化
 * （scripts/desktop-app-check.mjs），迁到 Tauri 后 CDP 没了宿主开关——
 * 但 WebView2 仍支持经环境变量打开远程调试，因此 E2E 不必换到
 * tauri-driver（其 Windows 侧还需 msedgedriver，成本高）。
 *
 * 做法：用独立 userData（WEBVIEW2_USER_DATA_FOLDER）+ 独立调试端口起应用，
 * 连 CDP 后直接查 DOM、发真实按键。默认跑三条最小断言：
 *   1. 编辑器挂载（.ProseMirror 存在）
 *   2. 输入文本落到文档
 *   3. Ctrl+B 真按键加粗（回归 f4f658f 的「双触发抵消」与 e.code 键位还原）
 *
 * 用法：
 *   node scripts/tauri-gui-check.mjs            # 默认 release 产物
 *   node scripts/tauri-gui-check.mjs --debug    # 用 target/debug
 *   node scripts/tauri-gui-check.mjs --kill     # 先结束残留 tmd 进程（CI 用）
 *   node scripts/tauri-gui-check.mjs --exe <path>
 *
 * 前置：npm run dist:tauri:win:dir（或 tauri build --no-bundle）先出 exe。
 *
 * 注意：单实例锁按 identifier 生效——本机已有 TMD 在跑时测试进程会立即退出
 * （脚本会给出提示）。想同时验证而不关掉手上那个，可打一个隔离 identifier 的包：
 *   npx tauri build --no-bundle --config <(echo '{"identifier":"com.chiangyang.tmd.e2e"}')
 * 再 `--exe` 指向它（同一 target 目录会覆盖正式产物，验证后需重打正式包）。
 * @author chiangyang
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.TMD_E2E_CDP_PORT ?? 9223)
const USE_DEBUG = process.argv.includes('--debug')
const KILL_STALE = process.argv.includes('--kill')
const exeArgIdx = process.argv.indexOf('--exe')
const PROFILE = USE_DEBUG ? 'debug' : 'release'
const EXE =
  exeArgIdx > 0 && process.argv[exeArgIdx + 1]
    ? process.argv[exeArgIdx + 1]
    : join(REPO, 'src-tauri', 'target', PROFILE, 'tmd.exe')

if (process.platform !== 'win32') {
  console.error('[tauri-gui-check] 仅支持 Windows（WebView2 CDP）；macOS 请走人工清单')
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error(`[tauri-gui-check] 找不到 ${EXE}\n先跑：npm run dist:tauri:win:dir`)
  process.exit(2)
}

/** 列出正在运行的 tmd.exe 进程 id（单实例锁会把新进程转交给它，CDP 端口起不来） */
function runningInstances() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process tmd -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
      ],
      { encoding: 'utf8' },
    )
    return out
      .split(/\s+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/** 最小 CDP 客户端（Node ≥22 自带 WebSocket，无需依赖） */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

/** 等调试端口出现渲染页目标（childExited 为真时提前放弃） */
async function waitForPage(timeoutMs = 20000, childExited = () => false) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childExited()) throw new Error('应用进程已退出')
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 端口未就绪，继续等 */
    }
    await sleep(250)
  }
  throw new Error(`等待 CDP 端口 ${PORT} 超时（应用是否启动失败？）`)
}

/** 在页面里求值并返回 JSON 值 */
async function evalJson(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常: ${result.exceptionDetails.text}`)
  }
  return result.result?.value
}

/** 发一次真实按键（CDP Input 域：默认 rawKeyDown + keyUp） */
async function pressKey(cdp, { key, code, vk, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  // --kill：CI/本机残留实例清场（同 identifier 的实例在跑时，新进程只会
  // 转交 argv 就退出，调试端口永远等不到）。不同 identifier 的隔离构建
  // 可以共存，故默认不预判拦截，交给「进程早退」检测给出准确提示。
  if (KILL_STALE) {
    const stale = runningInstances()
    if (stale.length) {
      console.log(`[tauri-gui-check] --kill：结束残留实例 PID ${stale.join(', ')}`)
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        'Get-Process tmd -ErrorAction SilentlyContinue | Stop-Process -Force',
      ])
      await sleep(1200)
    }
  }

  const userData = mkdtempSync(join(tmpdir(), 'tmd-e2e-'))
  console.log(`[tauri-gui-check] 启动 ${EXE}\n  userData=${userData}\n  cdp=:${PORT}`)
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: userData,
    },
    stdio: 'ignore',
  })
  let childExited = false
  child.on('exit', () => {
    childExited = true
  })

  let cdp
  try {
    let page
    try {
      page = await waitForPage(undefined, () => childExited)
    } catch (err) {
      if (childExited) {
        throw new Error(
          '应用启动后立即退出——通常是同 identifier 的实例已在运行（单实例锁把 argv 转交给它）。\n' +
            '  请关闭正在运行的 TMD 后重试，或加 --kill 清场。',
          { cause: err },
        )
      }
      throw err
    }
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // 等编辑器完成挂载（Milkdown 异步 create）
    let mounted = false
    for (let i = 0; i < 60 && !mounted; i++) {
      mounted = await evalJson(cdp, `!!document.querySelector('#editor .ProseMirror')`)
      if (!mounted) await sleep(250)
    }
    check('编辑器挂载', mounted)
    if (!mounted) throw new Error('编辑器未挂载，后续断言跳过')

    // 输入文本：聚焦内容节点后走 insertText（等价键入）
    await evalJson(cdp, `(() => {
      const pm = document.querySelector('#editor .ProseMirror')
      pm.focus()
      return true
    })()`)
    await cdp.send('Input.insertText', { text: 'hello e2e' })
    await sleep(300)
    const typed = await evalJson(cdp, `document.querySelector('#editor .ProseMirror').textContent`)
    check('文本输入落盘到文档', typed.includes('hello e2e'), JSON.stringify(typed).slice(0, 60))

    // Ctrl+A 全选 → Ctrl+B 加粗；断言 <strong> 出现（回归快捷键双触发/键位失配）
    await pressKey(cdp, { key: 'a', code: 'KeyA', vk: 65, modifiers: 2 })
    await sleep(150)
    await pressKey(cdp, { key: 'b', code: 'KeyB', vk: 66, modifiers: 2 })
    await sleep(400)
    const strong = await evalJson(cdp, `document.querySelectorAll('#editor strong').length`)
    check('Ctrl+B 加粗生效', strong >= 1, `strong=${strong}`)

    // 再按一次应取消（切换语义；双触发时净效果为零、此处会失败）
    await pressKey(cdp, { key: 'b', code: 'KeyB', vk: 66, modifiers: 2 })
    await sleep(400)
    const strongAfter = await evalJson(cdp, `document.querySelectorAll('#editor strong').length`)
    check('Ctrl+B 再按取消加粗', strongAfter === 0, `strong=${strongAfter}`)

    // Ctrl+Shift+8 无序列表（回归 e.code 键位还原：Shift+8 的 key 是 '*'）
    await pressKey(cdp, { key: '*', code: 'Digit8', vk: 56, modifiers: 10 }) // Ctrl(2)+Shift(8)
    await sleep(400)
    const ul = await evalJson(cdp, `document.querySelectorAll('#editor ul').length`)
    check('Ctrl+Shift+8 无序列表', ul >= 1, `ul=${ul}`)
  } finally {
    cdp?.close()
    child.kill()
    await sleep(500)
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      /* 应用退出前会短暂占用 userData，清理失败不影响结论 */
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[tauri-gui-check] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(`[tauri-gui-check] 失败: ${err.message}`)
  process.exit(1)
})
