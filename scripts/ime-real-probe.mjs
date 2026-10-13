/**
 * 真实输入法复现探针：用系统级按键注入（CGEvent → 用户当前输入法）测试
 * 「顿号变斜杠」，对照三个目标：
 *   A. ProseMirror 编辑器（contenteditable）
 *   B. 注入的裸 contenteditable div
 *   C. 注入的裸 <input>
 *
 * 原理：osascript System Events 的 key code 走完整系统输入管线（经过真实
 * 输入法 IME），能复现 CDP 合成事件无法触及的 IME 转换路径。
 *
 * 安全：打字前验证前台进程 unix id == 本探针启动的 Electron pid，不匹配
 * 立即中止（绝不把按键打进用户正在用的其他应用）。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  Cdp,
  RENDERER_PORT,
  MAIN_PORT,
  sleep,
  waitForTarget,
  waitForPortsFree,
  spawnApp,
  killTree,
} from './lib/desktop-harness.mjs'

const REPO = path.resolve(import.meta.dirname ?? '.', '..')

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15000 }).trim()
}

const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

// 前置：用户的正式 TMD 必须在关闭状态（单实例锁与 userData 共享）
try {
  const running = execFileSync('pgrep', ['-x', 'TMD'], { encoding: 'utf-8' }).trim()
  if (running) {
    console.log('请先退出正在使用的 TMD（单实例锁会导致复现实例静默退出），再重跑本探针')
    process.exit(2)
  }
} catch {
  /* 没在跑，继续 */
}

const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-real-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-real-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-real-notes-'))
const notePath = path.join(notesDir, 'real.md')
await writeFile(notePath, '起始行\n')

let child
try {
  await waitForPortsFree()
  child = spawnApp({ repo: REPO, profile, extraArgs: [notePath], env: { TMD_HOME_DIR: homeDir } })

  const nodeTarget = await waitForTarget(
    MAIN_PORT,
    (t) => t.type === 'node' || t.url?.startsWith('file:') || !!t.webSocketDebuggerUrl,
  )
  const main = new Cdp(nodeTarget.webSocketDebuggerUrl)
  await main.connect()
  await main.send('Runtime.enable')

  const page = await waitForTarget(
    RENDERER_PORT,
    (t) => t.type === 'page' && /index\.html/.test(t.url),
  )
  const renderer = new Cdp(page.webSocketDebuggerUrl)
  await renderer.connect()
  await renderer.send('Runtime.enable')

  async function ev(expression) {
    const res = await renderer.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300))
    return res.result.value
  }
  async function waitFor(expr, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await ev(expr)) return true
      await sleep(300)
    }
    return false
  }

  check(
    '编辑器挂载且 real.md 已打开',
    await waitFor(
      `document.querySelector('#editor .ProseMirror') && /real\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
    ),
  )

  // ProseMirror 根节点属性（对照 Chromium 回归 bug 的触发结构）
  console.log(
    '  [diag] ProseMirror 根属性:',
    await ev(`(() => {
    const el = document.querySelector('#editor .ProseMirror')
    return el ? el.outerHTML.slice(0, 200) : '无'
  })()`),
  )

  // 注入两个对照目标
  await ev(`(() => {
    const div = document.createElement('div')
    div.id = 'probe-ce'
    div.contentEditable = 'true'
    div.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;'
    document.body.appendChild(div)
    const input = document.createElement('input')
    input.id = 'probe-in'
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;'
    document.body.appendChild(input)
    return true
  })()`)

  // ── 安全闸门：本实例必须在前台 ──
  osa(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`,
  )
  await sleep(800)
  const frontPid = osa(
    `tell application "System Events" to get unix id of (first process whose frontmost is true)`,
  )
  if (String(frontPid) !== String(child.pid)) {
    console.log(
      `前台校验失败：前台进程 ${frontPid} ≠ 复现实例 ${child.pid}，中止按键注入（安全起见不打字）`,
    )
    process.exit(2)
  }
  console.log(`  [safety] 前台校验通过（unix id ${frontPid}），开始按键注入`)

  /** 按一个物理键码（42=\  44=/）并等待输入完成 */
  const press = async (code) => {
    osa(`tell application "System Events" to key code ${code}`)
    await sleep(500)
  }

  const pmText = () =>
    ev(
      `(() => { const ps = document.querySelectorAll('#editor .ProseMirror p'); return ps[ps.length - 1]?.textContent ?? '' })()`,
    )
  const ceText = () => ev(`document.getElementById('probe-ce')?.textContent ?? ''`)
  const inVal = () => ev(`document.getElementById('probe-in')?.value ?? ''`)

  // ── A. ProseMirror 编辑器 ──
  const pt = await ev(`(() => {
    const ps = document.querySelectorAll('#editor .ProseMirror p')
    const p = ps[ps.length - 1]
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.right - 4), y: Math.round(r.top + r.height / 2) }
  })()`)
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  await press(42)
  const a1 = await pmText()
  await press(44)
  const a2 = await pmText()
  console.log(
    `  [A] ProseMirror：键42(\\键)后 ${JSON.stringify(a1)}；键44(/键)后 ${JSON.stringify(a2)}`,
  )
  check('A. ProseMirror：物理 \\ 键（真实 IME）产出顿号', a1.endsWith('、'), JSON.stringify(a1))
  check('A. ProseMirror：物理 / 键（真实 IME）产出顿号', a2.endsWith('、'), JSON.stringify(a2))

  // ── B. 裸 contenteditable ──
  await ev(`document.getElementById('probe-ce').focus()`)
  await press(42)
  const b1 = await ceText()
  await press(44)
  const b2 = await ceText()
  console.log(
    `  [B] 裸 contenteditable：键42后 ${JSON.stringify(b1)}；键44后 ${JSON.stringify(b2)}`,
  )
  check(
    'B. 裸 contenteditable：物理 \\ 键产出顿号',
    b1.endsWith('、') || b1.endsWith('\\'),
    JSON.stringify(b1),
  )
  check(
    'B. 裸 contenteditable：物理 / 键产出顿号',
    b2.endsWith('、') || b2.endsWith('/'),
    JSON.stringify(b2),
  )

  // ── C. 裸 input ──
  await ev(`document.getElementById('probe-in').focus()`)
  await press(42)
  const c1 = await inVal()
  await press(44)
  const c2 = await inVal()
  console.log(`  [C] 裸 input：键42后 ${JSON.stringify(c1)}；键44后 ${JSON.stringify(c2)}`)
  check('C. 裸 input：物理 \\ 键产出顿号', c1.endsWith('、'), JSON.stringify(c1))
  check('C. 裸 input：物理 / 键产出顿号', c2.endsWith('、'), JSON.stringify(c2))

  // ── 判定摘要 ──
  const pmBroken = !a1.endsWith('、') && !a2.endsWith('、')
  const inputOk = c1.endsWith('、') && c2.endsWith('、')
  const ceBroken = !(b1.endsWith('、') || b1.endsWith('\\'))
  if (pmBroken && inputOk) {
    console.log(
      `\n★ 复现成功：ProseMirror 编辑器丢转换、裸 input 正常；裸 contenteditable ${ceBroken ? '同样异常 → contenteditable 级（Chromium/IME 交互）' : '正常 → ProseMirror 特有'}`,
    )
  } else if (!pmBroken) {
    console.log('\n本实例未复现（ProseMirror 侧正常）——需并入用户环境变量进一步定位')
  }
} catch (err) {
  check('探针执行无异常', false, String(err))
} finally {
  if (child) await killTree(child)
  await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(notesDir, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.passed)
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
