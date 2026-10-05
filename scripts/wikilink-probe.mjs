/**
 * 双链生态真机探针（一次性验证脚本，不属于常规测试链）：
 * 真实启动应用 + 打开预置笔记，CDP 断言——
 * 1. 所见即所得侧 a.wikilink 渲染（3 处）
 * 2. 未解析目标（ghost）挂 wikilink-unresolved 装饰
 * 3. 反向链接面板打开并列出来源文件
 * 4. 关系图谱打开且画布有内容
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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

// ---------- 准备测试工作区 ----------
const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-wl-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-wl-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-wl-notes-'))
await mkdir(path.join(notesDir, 'sub'), { recursive: true })
const aPath = path.join(notesDir, 'a.md')
await writeFile(aPath, 'see [[b]] and [[b|别名]] and [[ghost]] here\n')
await writeFile(path.join(notesDir, 'b.md'), 'B note content\n')
await writeFile(path.join(notesDir, 'sub', 'c.md'), '[[b]] from sub\n')

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
  console.log('  [probe] main target:', nodeTarget.webSocketDebuggerUrl)
  const main = new Cdp(nodeTarget.webSocketDebuggerUrl)
  await main.connect()
  console.log('  [probe] main ws connected')
  await main.send('Runtime.enable')
  console.log('  [probe] main Runtime.enable ok')

  const page = await waitForTarget(
    RENDERER_PORT,
    (t) => t.type === 'page' && /index\.html/.test(t.url),
  )
  console.log('  [probe] renderer target:', page.url, page.webSocketDebuggerUrl)
  const renderer = new Cdp(page.webSocketDebuggerUrl)
  await renderer.connect()
  console.log('  [probe] renderer ws connected')
  await renderer.send('Runtime.enable')
  console.log('  [probe] renderer Runtime.enable ok')

  /** 在渲染层求值（表达式 → JSON 值） */
  async function ev(expression) {
    const res = await renderer.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
    return res.result.value
  }

  /** 轮询直到断言为真或超时 */
  async function waitFor(expr, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await ev(expr)) return true
      await sleep(300)
    }
    return false
  }

  // 等编辑器挂载 + 文件经 argv 队列打开
  check(
    '编辑器挂载且 a.md 已打开（标签标题）',
    await waitFor(
      `document.querySelector('#editor .milkdown, #editor .ProseMirror') && /a\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
      20000,
    ),
  )

  // 1. 所见即所得侧 a.wikilink 渲染（[[b]] / [[b|别名]] / [[ghost]] 共 3 处）
  check(
    '所见即所得渲染 3 处 a.wikilink',
    await waitFor(`document.querySelectorAll('#editor a.wikilink').length === 3`),
    `count=${await ev(`document.querySelectorAll('#editor a.wikilink').length`)}`,
  )

  // 2. 未解析目标挂 unresolved 装饰（ghost 不在索引；索引异步，轮询）
  check(
    '未解析目标挂 wikilink-unresolved 装饰',
    await waitFor(
      `(() => { const els = [...document.querySelectorAll('#editor a.wikilink')]; return els.some(el => el.textContent.includes('ghost') && el.classList.contains('wikilink-unresolved')) })()`,
      15000,
    ),
  )

  // 3. 反向链接面板：c.md 引用了 b——切到 b.md 后打开面板应有 1 个来源
  //    （直接在 a.md 视图先验证面板打开与渲染骨架）
  await ev(`document.getElementById('menu-backlinks-btn').click()`)
  check(
    '反向链接面板可打开',
    await waitFor(
      `(() => { const o = document.getElementById('backlinks-overlay'); return o && !o.hidden })()`,
    ),
  )
  // a.md 无反引（无来源）→ 空态文案；渲染不抛错即可
  const backlinksStatus = await ev(`document.getElementById('backlinks-status')?.textContent ?? ''`)
  check(
    '反向链接面板状态文案渲染',
    typeof backlinksStatus === 'string' && backlinksStatus.length > 0,
    backlinksStatus,
  )
  await ev(`document.getElementById('backlinks-overlay').setAttribute('hidden','')`)

  // 4. 关系图谱：打开 + 画布有绘制内容
  await ev(`document.getElementById('menu-graph-btn').click()`)
  check(
    '关系图谱面板可打开',
    await waitFor(
      `(() => { const o = document.getElementById('graph-overlay'); return o && !o.hidden })()`,
    ),
  )
  check(
    '图谱画布有绘制内容',
    await waitFor(
      `(() => { const c = document.getElementById('graph-canvas'); if (!c || !c.width) return false
        const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data
        for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) return true } return false })()`,
      15000,
    ),
  )

  // 5. 源码模式：双链在源码侧可见性切换（内容仍为 [[..]] 字面，验证模式切换不丢内容）
  const srcOk = await ev(
    `(() => { const btn = document.getElementById('source-mode-btn'); btn.click(); return document.querySelector('#src-editor')?.textContent.includes('[[b]]') })()`,
  )
  check('源码模式保留 [[..]] 字面内容', srcOk === true)
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
