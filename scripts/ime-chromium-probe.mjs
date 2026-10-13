/**
 * Chromium 内核级输入法探针：用同款 Electron（44.2.0 / Chromium 152）起一个
 * 最小应用（contenteditable + input + 事件记录器），用系统级按键注入（真实
 * 输入法）对照测试两个目标，判定「顿号异常」是否为内核/输入法交互问题
 * （与 TMD 业务代码无关）。
 *
 * 安全：按键注入前验证前台进程 unix id == 本实例 pid，不匹配立即中止。
 * 应用名独立（tmd-ime-mini）→ userData 独立 → 与用户正在运行的 TMD 无锁冲突。
 */
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Cdp, sleep, killTree } from './lib/desktop-harness.mjs'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const PORT = 9333

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15000 }).trim()
}

const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

// ── 生成最小应用 ──
const appDir = await mkdtemp(path.join(tmpdir(), 'tmd-ime-mini-'))
await writeFile(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: 'tmd-ime-mini', version: '1.0.0', main: 'main.js' }, null, 2),
)
await writeFile(
  path.join(appDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 700, height: 460 })
  win.loadFile('index.html')
})
app.on('window-all-closed', () => app.quit())
`,
)
await writeFile(
  path.join(appDir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px -apple-system; padding: 12px; }
  #ce { border: 1px solid #999; min-height: 48px; padding: 6px; }
  #in { width: 96%; margin-top: 8px; }
  #log { font: 11px monospace; white-space: pre-wrap; color: #666; max-height: 200px; overflow: auto; }
  </style></head><body>
  <div id="ce" contenteditable="true"></div>
  <input id="in" placeholder="input" />
  <div id="v2" style="border:1px solid #ccc;min-height:24px"><div contenteditable="true" data-var="v2"></div></div>
  <div contenteditable="true" data-var="v3" autocorrect="off" autocapitalize="off" spellcheck="false" style="border:1px solid #ccc;min-height:24px"></div>
  <div contenteditable="true" data-var="v4" style="border:1px solid #ccc;min-height:24px"><p>abc</p></div>
  <div data-var="v5wrap" style="border:1px solid #ccc"><div autocorrect="off" contenteditable="true" data-var="v5"><div>abc</div></div></div>
  <pre id="log"></pre>
  <script>
    window.__events = []
    const push = (e) => {
      window.__events.push({
        type: e.type, key: e.key, code: e.code, data: e.data,
        inputType: e.inputType, composing: e.isComposing,
        prevented: null, target: e.target && e.target.id || '(doc)',
      })
      const rec = window.__events[window.__events.length - 1]
      setTimeout(() => { rec.prevented = e.defaultPrevented }, 0)
      document.getElementById('log').textContent = window.__events.slice(-8).map(r => JSON.stringify(r)).join('\\n')
    }
    for (const t of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend']) {
      document.addEventListener(t, push, true)
    }
    window.__clear = () => { window.__events = [] }
  </script>
</body></html>
`,
)

let child
try {
  child = spawn(ELECTRON, [appDir, `--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })

  // 等页面目标
  let page = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !page) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url ?? ''))
    } catch {
      /* 端口未就绪 */
    }
    if (!page) await sleep(400)
  }
  if (!page) throw new Error('最小应用页面目标未出现')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  async function ev(expression) {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300))
    return res.result.value
  }

  await sleep(500)

  // ── 安全闸门 ──
  osa(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`,
  )
  await sleep(800)
  const frontPid = osa(
    `tell application "System Events" to get unix id of (first process whose frontmost is true)`,
  )
  if (String(frontPid) !== String(child.pid)) {
    console.log(`前台校验失败：${frontPid} ≠ ${child.pid}，中止（安全起见不打字）`)
    process.exit(2)
  }
  console.log(`  [safety] 前台校验通过（unix id ${frontPid}）`)

  const press = async (code) => {
    osa(`tell application "System Events" to key code ${code}`)
    await sleep(500)
  }

  /** 单次按键追踪：清事件记录、按一个物理键、读内容与增量 */
  const trace = async (readExpr, code, label) => {
    await ev(`window.__clear(); true`)
    const before = await ev(readExpr)
    osa(`tell application "System Events" to key code ${code}`)
    await sleep(500)
    const after = await ev(readExpr)
    const events = await ev(`window.__events`)
    console.log(
      `  ${label} 键${code}(${code === 42 ? '\\\\' : '/'})：${JSON.stringify(before)} → ${JSON.stringify(after)}（+${after.length - before.length} 字符）`,
    )
    if (events.length) console.log(`    事件：${JSON.stringify(events)}`)
  }

  // ── A. 基线 contenteditable：42,42,44,44 逐个追踪 ──
  await ev(`document.getElementById('ce').focus(); true`)
  const ceRead = `document.getElementById('ce').textContent`
  for (const code of [42, 42, 44, 44]) await trace(ceRead, code, '[A] 基线contenteditable')

  // ── B. input 对照 ──
  await ev(`document.getElementById('in').focus(); true`)
  const inRead = `document.getElementById('in').value`
  for (const code of [42, 42, 44, 44]) await trace(inRead, code, '[B] input')

  // ── C. DOM 结构变体：各自「聚焦后首按」是否被吞 ──
  for (const v of ['v2', 'v3', 'v4', 'v5']) {
    await ev(`document.querySelector('[data-var="${v}"]').focus(); true`)
    await trace(`document.querySelector('[data-var="${v}"]').textContent`, 42, `[C:${v}] 首按`)
  }

  console.log('\n判定见上方逐键追踪输出（A/B 每个键的落字与事件流对照）')
} catch (err) {
  check('探针执行无异常', false, String(err))
} finally {
  if (child) killTree(child)
  await rm(appDir, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.passed)
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
