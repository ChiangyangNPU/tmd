/**
 * 隔离版 DOM 结构实验：每个变体用独立的新 Electron 实例（全新文档），
 * 聚焦后只按一次顿号键，判定「聚焦后首次按键是否被吞」是否与 DOM 结构相关。
 * 用真实 IME（系统级按键注入）。
 *
 * 变体：
 *  baseline-empty : <div contenteditable>（空）
 *  baseline-text  : <div contenteditable>abc
 *  wrapped-empty  : <div><div contenteditable></div></div>（PM 形态：外层包裹）
 *  wrapped-text   : 同上 + abc
 *  attrs          : <div contenteditable autocorrect=off autocapitalize=off spellcheck=false>
 *  inner-p        : <div contenteditable><p>abc</p></div>
 *  bug-trigger    : <div><div autocorrect=off contenteditable><div>abc</div></div></div>（流传的触发结构）
 *  focus-again    : wrapped-text 上测试「再次聚焦后首按」（同页第二次聚焦）
 *  input          : 对照组
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Cdp, sleep, killTree } from './lib/desktop-harness.mjs'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const PORT = 9334

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 15000 }).trim()
}

const VARIANTS = {
  'baseline-empty': '<div id="t" contenteditable="true"></div>',
  'baseline-text': '<div id="t" contenteditable="true">abc</div>',
  'wrapped-empty': '<div><div id="t" contenteditable="true"></div></div>',
  'wrapped-text': '<div><div id="t" contenteditable="true">abc</div></div>',
  attrs:
    '<div id="t" contenteditable="true" autocorrect="off" autocapitalize="off" spellcheck="false"></div>',
  'inner-p': '<div id="t" contenteditable="true"><p>abc</p></div>',
  'bug-trigger':
    '<div><div autocorrect="off" contenteditable="true"><div id="t" contenteditable="true"><div>abc</div></div></div></div>',
}

const appDir = await mkdtemp(path.join(tmpdir(), 'tmd-ime-iso-'))
await writeFile(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: 'tmd-ime-iso', version: '1.0.0', main: 'main.js' }, null, 2),
)
await writeFile(
  path.join(appDir, 'main.js'),
  `const { app, BrowserWindow } = require('electron')\napp.whenReady().then(() => {\n  const win = new BrowserWindow({ width: 640, height: 400 })\n  win.loadFile('index.html')\n})\napp.on('window-all-closed', () => app.quit())\n`,
)

async function runVariant(name, bodyHtml, opts = {}) {
  await writeFile(
    path.join(appDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px -apple-system;padding:10px} #t,#in{border:1px solid #999;min-height:36px;padding:4px} #in{width:95%;margin-top:6px}</style></head><body>
    ${bodyHtml}
    <input id="in" />
    <script>window.__events=[];for(const ty of['keydown','beforeinput','input']){document.addEventListener(ty,e=>window.__events.push({type:e.type,key:e.key,data:e.data}),true)}</script>
    </body></html>`,
  )

  const child = spawn(ELECTRON, [appDir, `--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  try {
    let page = null
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && !page) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        page = (await res.json()).find((t) => t.type === 'page' && /index\.html/.test(t.url ?? ''))
      } catch {
        /* not ready */
      }
      if (!page) await sleep(350)
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
      return res.result.value
    }
    await sleep(400)

    // 安全：前台必须是本实例
    osa(
      `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`,
    )
    await sleep(600)
    const frontPid = osa(
      `tell application "System Events" to get unix id of (first process whose frontmost is true)`,
    )
    if (String(frontPid) !== String(child.pid))
      throw new Error(`前台校验失败 ${frontPid} != ${child.pid}`)

    // 聚焦目标 → 首按一次 → 读结果
    await ev(`document.getElementById('t').focus(); true`)
    await sleep(300)
    osa('tell application "System Events" to key code 42')
    await sleep(500)
    const text1 = await ev(`document.getElementById('t').textContent`)
    const ev1 = await ev(`window.__events.length`)

    // 同页「再次聚焦再按」（可选）：按到 input 上再聚焦回来
    let secondFocus = null
    if (opts.secondFocus) {
      await ev(`document.getElementById('in').focus(); true`)
      await sleep(200)
      await ev(`document.getElementById('t').focus(); true`)
      await sleep(300)
      osa('tell application "System Events" to key code 42')
      await sleep(500)
      secondFocus = await ev(`document.getElementById('t').textContent`)
    }

    const baseline = opts.emptyExpected ? '' : 'abc'
    const firstDropped = text1 === baseline || text1 === ''
    return { text1, ev1, firstDropped, secondFocus }
  } finally {
    killTree(child)
    await sleep(400)
  }
}

console.log('变体隔离实验（每变体独立实例；真实豆包 IME 按一次 \\ 键）:')
console.log('变体 | 首按后内容 | 事件数 | 首按被吞?')
const rows = []
for (const [name, html] of Object.entries(VARIANTS)) {
  const r = await runVariant(name, html)
  rows.push({ name, ...r })
  console.log(
    `  ${name.padEnd(14)} | ${JSON.stringify(r.text1).padEnd(10)} | ${String(r.ev1).padEnd(3)} | ${r.firstDropped ? '★ 被吞' : '正常'}`,
  )
}

// 同页再聚焦测试（wrapped-text）
const r2 = await runVariant('wrapped-text+refocus', VARIANTS['wrapped-text'], { secondFocus: true })
console.log(
  `  再次聚焦后内容：${JSON.stringify(r2.secondFocus)}（首按 ${JSON.stringify(r2.text1)}）`,
)

await rm(appDir, { recursive: true, force: true }).catch(() => {})
console.log('\n完成')
