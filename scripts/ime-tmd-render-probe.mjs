/**
 * TMD 渲染层真机 IME 探针：最小 Electron � 壳加载仓库的 dist/index.html（浏览器
 * 模式，不经主进程业务代码、不与用户正在运行的 TMD 争单实例锁），用系统级
 * 按键注入（真实 IME，物理键码 42=\ 44=/）在真实 ProseMirror 编辑器上复现
 * 「顿号变 /」并抓取完整事件流。
 *
 * 安全：按键注入前验证前台 unix id == 本实例 pid。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Cdp, sleep, killTree } from './lib/desktop-harness.mjs'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const REPO = path.resolve(import.meta.dirname ?? '.', '..')
const PORT = 9335

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15000 }).trim()
}

const appDir = await mkdtemp(path.join(tmpdir(), 'tmd-ime-render-'))
await writeFile(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: 'tmd-ime-render', version: '1.0.0', main: 'main.js' }, null, 2),
)
await writeFile(
  path.join(appDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700 })
  win.loadFile(${JSON.stringify(path.join(REPO, 'dist', 'index.html'))})
})
app.on('window-all-closed', () => app.quit())
`,
)

let child
try {
  child = spawn(ELECTRON, [appDir, `--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })

  let page = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !page) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      page = (await res.json()).find((t) => t.type === 'page' && /index\.html/.test(t.url ?? ''))
    } catch {
      /* not ready */
    }
    if (!page) await sleep(400)
  }
  if (!page) throw new Error('页面未出现')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')

  const ev = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300))
    return res.result.value
  }
  const waitFor = async (expr, timeoutMs = 30000) => {
    const dl = Date.now() + timeoutMs
    while (Date.now() < dl) {
      if (await ev(expr)) return true
      await sleep(300)
    }
    return false
  }

  // 等 PM 编辑器挂载
  const mounted = await waitFor(`!!document.querySelector('#editor .ProseMirror')`)
  console.log('编辑器挂载:', mounted ? 'OK' : '失败')
  if (!mounted) throw new Error('编辑器未挂载（浏览器模式 boot 失败？）')

  // 事件记录器（捕获阶段，记录 keydown/beforeinput/input/composition）
  await ev(`(() => {
    window.__ev = []
    for (const t of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
      document.addEventListener(t, (e) => {
        window.__ev.push({
          type: e.type, key: e.key, data: e.data, inputType: e.inputType,
          composing: e.isComposing, target: e.target?.className || e.target?.id || '(doc)',
        })
      }, true)
    }
    return true
  })()`)

  console.log(
    'ProseMirror 根节点属性:',
    await ev(`(document.querySelector('#editor .ProseMirror')?.outerHTML ?? '').slice(0, 240)`),
  )

  // 点击编辑器末尾聚焦（真实用户路径）
  const pt = await ev(`(() => {
    const ps = document.querySelectorAll('#editor .ProseMirror p')
    const p = ps[ps.length - 1] ?? document.querySelector('#editor .ProseMirror')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pt.x,
    y: pt.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })

  // 安全闸门
  osa(
    `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`,
  )
  await sleep(800)
  const frontPid = osa(
    `tell application "System Events" to get unix id of (first process whose frontmost is true)`,
  )
  if (String(frontPid) !== String(child.pid)) {
    console.log(`前台校验失败：${frontPid} != ${child.pid}，中止`)
    process.exit(2)
  }

  const readEditor = `document.querySelector('#editor .ProseMirror')?.textContent ?? ''`
  const pressAndTrace = async (code, label) => {
    await ev(`window.__ev = []; true`)
    const before = await ev(readEditor)
    osa(`tell application "System Events" to key code ${code}`)
    await sleep(600)
    const after = await ev(readEditor)
    const events = await ev(`window.__ev`)
    console.log(
      `  ${label} 键${code}(${code === 42 ? '\\\\' : '/'})：[${JSON.stringify(before)}] → [${JSON.stringify(after)}]`,
    )
    console.log(`    事件：${JSON.stringify(events)}`)
    return { before, after, events }
  }

  // 用户路径：点进编辑器后连续按 （若首按被吞就是「点了没东西」，若出 / 就是复现）
  await pressAndTrace(42, '[TMD渲染层] 第1次按 \\')
  await pressAndTrace(42, '[TMD渲染层] 第2次按 \\')
  await pressAndTrace(44, '[TMD渲染层] 第3次按 /')
  await pressAndTrace(44, '[TMD渲染层] 第4次按 /')

  // 换焦点再回到编辑器（模拟用户「点别处再点回来」）
  const srcBtn = await ev(
    `(() => { const b = document.getElementById('source-mode-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`,
  )
  if (srcBtn) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: srcBtn.x,
      y: srcBtn.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: srcBtn.x,
      y: srcBtn.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    await sleep(400)
    // 切回所见即所得
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: srcBtn.x,
      y: srcBtn.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: srcBtn.x,
      y: srcBtn.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    await sleep(600)
    // 重新点击编辑器
    const pt2 = await ev(`(() => {
      const ps = document.querySelectorAll('#editor .ProseMirror p')
      const p = ps[ps.length - 1] ?? document.querySelector('#editor .ProseMirror')
      const r = p.getBoundingClientRect()
      return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pt2.x,
      y: pt2.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pt2.x,
      y: pt2.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    await sleep(300)
    await pressAndTrace(42, '[TMD渲染层] 重聚焦后按 \\')
  }

  console.log('\n完成（对照上面每次按键的实际落字与事件流）')
} catch (err) {
  console.log('探针异常:', String(err).slice(0, 400))
} finally {
  if (child) killTree(child)
  await rm(appDir, { recursive: true, force: true }).catch(() => {})
}
