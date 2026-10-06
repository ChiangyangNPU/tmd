/**
 * 脏圆点行为真机探针（一次性验证脚本）：验证「加一个字又删掉 = 回到原始
 * 状态，标签不应显示已修改圆点」。
 *
 * 流程：真实启动应用并经 argv 打开笔记 → 点击编辑区聚焦 → Input.insertText
 * 输入 x → 断言标签出现「• 」→ 退格删除 → 轮询断言圆点在防抖节拍后消失
 * （清除走 800ms 低优拍点的内容比对，非瞬时）。
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
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

const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-dirty-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-dirty-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-dirty-notes-'))
const notePath = path.join(notesDir, 'dirty.md')
await writeFile(notePath, '基线内容一二三')

let child
try {
  await waitForPortsFree()
  child = spawnApp({
    repo: REPO,
    profile,
    extraArgs: [notePath],
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
      await sleep(250)
    }
    return false
  }

  /** 活动标签是否带脏圆点 */
  const isDirty = () =>
    ev(`(document.querySelector('#tab-bar .tab.active span')?.textContent ?? '').startsWith('• ')`)

  // 编辑器挂载 + 文件打开（初始必须无圆点）
  check(
    '编辑器挂载且 dirty.md 已打开',
    await waitFor(
      `document.querySelector('#editor .milkdown, #editor .ProseMirror') && /dirty\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
      20000,
    ),
  )
  await sleep(500)
  check(
    '初始状态无脏圆点',
    !(await isDirty()),
    JSON.stringify(await ev(`document.querySelector('#tab-bar .tab.active span')?.textContent`)),
  )

  // 点击段落末尾聚焦并把光标放到行尾
  const point = await ev(`(() => {
    const p = document.querySelector('.page-scroll p')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) }
  })()`)
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await renderer.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })

  // 输入一个字 x（走真实文本插入）
  await renderer.send('Input.insertText', { text: 'x' })
  await sleep(300)
  check(
    '输入一个字后圆点出现',
    await isDirty(),
    JSON.stringify(await ev(`document.querySelector('#tab-bar .tab.active span')?.textContent`)),
  )

  // 退格删掉这个字
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  })
  await renderer.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  })
  await sleep(300)
  const afterDelete = await ev(`document.querySelector('.page-scroll p')?.textContent`)
  console.log('  [probe] 删字后编辑器内容:', JSON.stringify(afterDelete))

  // 清除走 800ms 防抖节拍的内容比对：轮询最多 6s
  let cleared = false
  for (let i = 0; i < 24; i++) {
    await sleep(250)
    if (!(await isDirty())) {
      cleared = true
      break
    }
  }
  check(
    '删字回到原状后圆点消失（≤800ms 拍点 + 余量）',
    cleared,
    JSON.stringify(await ev(`document.querySelector('#tab-bar .tab.active span')?.textContent`)),
  )

  // 诊断：拍点序列化产物（恢复副本）与基线逐字节对比——验证「尾随换行差异」假说
  const recovered = await ev(`localStorage.getItem('tmd:doc:v1')`)
  const baseline = '基线内容一二三'
  console.log('  [probe] 基线   :', JSON.stringify(baseline))
  console.log('  [probe] 序列化 :', JSON.stringify(recovered))
  console.log(
    '  [probe] 相等?  :',
    recovered === baseline,
    '| 仅差尾随换行?',
    recovered === baseline + '\n',
  )

  // 附加验证：磁盘文件不应被写入（自动保存默认关闭，内容未变也不该写）
  const disk = await readFile(notePath, 'utf-8')
  check('磁盘文件保持原内容（未被无谓写盘）', disk === '基线内容一二三', JSON.stringify(disk))
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
