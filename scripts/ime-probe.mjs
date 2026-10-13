/**
 * 顿号/反斜杠输入诊断探针（一次性排查脚本）：
 * 在真实应用里观察编辑器对三类输入的原始反应——
 * 1. IME 已提交文本「、」（Input.insertText）是否原样进文档
 * 2. 原生反斜杠字符键（\\）落进文档的实际字符 + keydown 是否被 defaultPrevented
 * 3. 模拟 IME 组合序列（imeSetComposition('\\') → insertText('、')）——最接近
 *    中文输入法按顿号键的真实事件流
 * 同时对「注入的裸 <input>」做对照（同一窗口、无应用处理器）。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-ime-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-ime-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-ime-notes-'))
const notePath = path.join(notesDir, 'probe.md')
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
    '编辑器挂载且 probe.md 已打开',
    await waitFor(
      `document.querySelector('#editor .ProseMirror') && /probe\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
    ),
  )

  // keydown 记录器（捕获阶段，记录 key/code/isComposing/defaultPrevented）
  await ev(`(() => {
    if (!window.__kdInstalled) {
      window.__kdInstalled = true
      window.__kd = []
      window.addEventListener('keydown', (e) => {
        const rec = { key: e.key, code: e.code, composing: e.isComposing, prevented: null }
        window.__kd.push(rec)
        setTimeout(() => { rec.prevented = e.defaultPrevented }, 0)
      }, true)
    }
    return true
  })()`)

  /** 取编辑器末段文本（追加输入后观察点） */
  const lastPara = () =>
    ev(
      `(() => { const ps = document.querySelectorAll('#editor .ProseMirror p'); return ps[ps.length - 1]?.textContent ?? '' })()`,
    )

  // 点击末尾聚焦并置光标段尾
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

  // ── ① 已提交文本「、」──
  await renderer.send('Input.insertText', { text: '、' })
  await sleep(250)
  const t1 = await lastPara()
  check('① 已提交的顿号「、」原样进文档', t1.endsWith('、'), JSON.stringify(t1))

  // ── ② 原生反斜杠字符键 ──
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\\',
    unmodifiedText: '\\',
    key: '\\',
    code: 'Backslash',
    windowsVirtualKeyCode: 220,
    nativeVirtualKeyCode: 42,
  })
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '\\',
    code: 'Backslash',
    windowsVirtualKeyCode: 220,
    nativeVirtualKeyCode: 42,
  })
  await sleep(250)
  const t2 = await lastPara()
  check('② 反斜杠键落进文档的就是「\\」本身（未被转成 /）', t2.endsWith('\\'), JSON.stringify(t2))

  // ── ③ 模拟 IME 组合：composition('\\') → commit('、') ──
  await renderer.send('Input.imeSetComposition', { text: '\\', selectionStart: 1, selectionEnd: 1 })
  await sleep(150)
  const during = await lastPara()
  await renderer.send('Input.insertText', { text: '、' })
  await sleep(250)
  const t3 = await lastPara()
  check(
    '③ IME 组合序列（\\ → 提交 、）最终落「、」',
    t3.endsWith('、'),
    `组合中=${JSON.stringify(during)} 提交后=${JSON.stringify(t3)}`,
  )

  // ── ④ keydown 日志（是否有应用处理器 preventDefault）──
  const log = await ev(
    `window.__kd.filter(r => r.key === '\\\\' || r.key === '/' || r.code === 'Backslash' || r.code === 'Slash')`,
  )
  check(
    '④ 反斜杠/斜杠 keydown 未被应用 preventDefault',
    Array.isArray(log) && log.every((r) => r.prevented !== true),
    JSON.stringify(log),
  )

  // ── ⑤ 对照组：注入裸 input（同窗口、无应用处理器）──
  const bare = await ev(`(() => {
    const input = document.createElement('input')
    input.id = 'probe-bare-input'
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.focus()
    return true
  })()`)
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\\',
    unmodifiedText: '\\',
    key: '\\',
    code: 'Backslash',
    windowsVirtualKeyCode: 220,
    nativeVirtualKeyCode: 42,
  })
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '\\',
    code: 'Backslash',
    windowsVirtualKeyCode: 220,
    nativeVirtualKeyCode: 42,
  })
  await sleep(150)
  const bareVal = await ev(`document.getElementById('probe-bare-input')?.value ?? ''`)
  check('⑤ 对照：裸 input 接收到「\\」', bare === true && bareVal === '\\', JSON.stringify(bareVal))

  // ── ⑥ 源码模式（CodeMirror）──
  await ev(`document.getElementById('source-mode-btn').click()`)
  await waitFor(`!!document.querySelector('#src-editor .cm-content')`)
  await ev(`document.querySelector('#src-editor .cm-content').focus()`)
  await renderer.send('Input.insertText', { text: '、' })
  await sleep(250)
  const cmHasDun = await ev(`document.querySelector('#src-editor')?.textContent.includes('、')`)
  check('⑥ 源码模式：顿号原样进 CodeMirror', cmHasDun === true)

  console.log('\\n—— keydown 全量日志（tail 12）——')
  console.log(JSON.stringify(await ev(`window.__kd.slice(-12)`), null, 1))
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
