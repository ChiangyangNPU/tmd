/**
 * 图谱对齐真机探针（一次性验证脚本）：验证 Phase 1/2 新功能——
 * ① 全库图谱：面板打开 + 统计文案 + 设置弹层开合与 localStorage 持久化
 * ② 局部图谱侧边栏：面板打开 + 邻域计数（含幽灵节点）+ 画布有内容 + 层数切换
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
  results.push(passed)
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-ga-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-ga-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-ga-notes-'))
const aPath = path.join(notesDir, 'a.md')
await writeFile(aPath, 'see [[b]] and [[待写]] here\n')
await writeFile(path.join(notesDir, 'b.md'), 'B note\n')

let child
try {
  await waitForPortsFree()
  child = spawnApp({
    repo: REPO,
    profile,
    extraArgs: [aPath],
    env: { TMD_HOME_DIR: homeDir },
  })

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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
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

  function canvasInk(selector) {
    return `(() => { const c = document.querySelector('${selector}'); if (!c || !c.width) return false
      const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data
      for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) return true } return false })()`
  }

  // ---------- ① 全库图谱 ----------
  check(
    '编辑器挂载且 a.md 已打开',
    await waitFor(
      `document.querySelector('#editor .milkdown, #editor .ProseMirror') && /a\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
      20000,
    ),
  )
  await ev(`document.getElementById('menu-graph-btn').click()`)
  check(
    '全库图谱面板打开',
    await waitFor(
      `(() => { const o = document.getElementById('graph-overlay'); return o && !o.hidden })()`,
    ),
  )
  check(
    '统计文案渲染（1 篇笔记，幽灵不计入）',
    await waitFor(
      `document.getElementById('graph-status')?.textContent.includes('2 篇笔记')`,
      10000,
    ),
    await ev(`document.getElementById('graph-status')?.textContent`),
  )

  // 设置弹层：开合 + 幽灵节点开关持久化
  await ev(`document.getElementById('graph-settings-btn').click()`)
  check(
    '设置弹层可打开',
    await waitFor(
      `(() => { const p = document.getElementById('graph-settings-pop'); return p && !p.hidden })()`,
    ),
  )
  await ev(`document.getElementById('graph-opt-ghosts').click()`)
  const persisted = await ev(
    `JSON.parse(localStorage.getItem('tmd:graph-settings') ?? '{}').showGhosts`,
  )
  check('幽灵开关关闭并持久化', persisted === false, JSON.stringify(persisted))
  await ev(`document.getElementById('graph-opt-ghosts').click()`)
  const persisted2 = await ev(
    `JSON.parse(localStorage.getItem('tmd:graph-settings') ?? '{}').showGhosts`,
  )
  check('幽灵开关重新开启', persisted2 === true)
  // 搜索过滤持久化
  await ev(
    `(() => { const i = document.getElementById('graph-filter'); i.value = 'b'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
  )
  const querySaved = await ev(
    `JSON.parse(localStorage.getItem('tmd:graph-settings') ?? '{}').query`,
  )
  check('搜索过滤持久化', querySaved === 'b', JSON.stringify(querySaved))
  await ev(`document.getElementById('graph-close-btn').click()`)
  check(
    '全库图谱可关闭',
    await waitFor(
      `(() => { const o = document.getElementById('graph-overlay'); return o && o.hidden })()`,
    ),
  )

  // ---------- ② 局部图谱侧边栏 ----------
  await ev(`document.getElementById('menu-localgraph-btn').click()`)
  check(
    '局部图谱侧边栏面板打开',
    await waitFor(
      `(() => { const p = document.getElementById('relations-panel'); return p && !p.hidden })()`,
    ),
  )
  // 邻居 = b（命中）+ 待写（幽灵），共 2 篇
  check(
    '邻域计数含幽灵节点（2 篇相邻笔记）',
    await waitFor(
      `document.getElementById('localgraph-status')?.textContent.includes('2 篇相邻笔记')`,
      15000,
    ),
    await ev(`document.getElementById('localgraph-status')?.textContent`),
  )
  check('迷你图谱画布有绘制内容', await waitFor(canvasInk('#localgraph-canvas'), 10000))
  // 切 2 层：无二跳邻居，计数不变但面板存活
  await ev(`document.querySelector('#relations-panel [data-depth="2"]').click()`)
  check(
    '层数切换后面板存活',
    await waitFor(
      `document.getElementById('localgraph-status')?.textContent.includes('2 篇相邻笔记')`,
      10000,
    ),
  )
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  check(
    'Esc 可关闭局部图谱面板',
    await waitFor(
      `(() => { const p = document.getElementById('relations-panel'); return p && p.hidden })()`,
    ),
  )
} catch (err) {
  check('探针执行无异常', false, String(err))
} finally {
  if (child) await killTree(child)
  await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(notesDir, { recursive: true, force: true }).catch(() => {})
}

const passed = results.filter(Boolean).length
console.log(`\n===== 汇总：${passed}/${results.length} 断言通过 =====`)
process.exit(passed === results.length ? 0 : 1)
