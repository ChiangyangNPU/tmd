/**
 * 手动验收三项的真机探针（一次性验证脚本）：改名自动重写 / 导出降级 / 分屏右键菜单。
 *
 * 流程：真实启动应用并经 argv 打开 笔记A → ⋯菜单挂载测试文件夹（对话框 stub
 * 指向临时目录）→ ① 文件树右键重命名 笔记B→笔记D，断言磁盘上 笔记A 的引用
 * 全部重写（别名/标题锚/相对形态保留、围栏不动）→ ② 触发 HTML/LaTeX 导出
 * （保存框 stub 按扩展名落盘），断言双链降级为纯文本/样式 span、无 [[ 残留 →
 * ③ 开分屏，用 CDP 真实鼠标事件做双击选区与右键，断言两侧菜单条目随可编辑
 * 状态变化（源码侧无格式化组、只读 PM 侧仅复制）。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-fv-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-fv-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-fv-notes-'))
const workDir = await mkdtemp(path.join(tmpdir(), 'tmd-fv-work-'))
await mkdir(path.join(notesDir, 'sub'), { recursive: true })
const aPath = path.join(notesDir, '笔记A.md')
const bPath = path.join(notesDir, '笔记B.md')
await writeFile(
  aPath,
  [
    '普通 [[笔记B]] 和 [[笔记B|别名样式]] 和 [[笔记B#安装]] 和 [[ghost]]',
    '',
    '代码块:',
    '```',
    '[[笔记B]]',
    '```',
    '',
    '导出测试 [[笔记B|别名样式]]',
    '',
  ].join('\n'),
)
await writeFile(bPath, '# 安装\n\nB 的内容\n')
await writeFile(path.join(notesDir, 'sub', 'c.md'), '[[笔记B]] from sub\n')

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
    if (res.exceptionDetails) {
      throw new Error('求值异常: ' + JSON.stringify(res.exceptionDetails.exception?.description))
    }
    return res.result.value
  }

  async function waitFor(expr, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await ev(expr)) return true
      await sleep(300)
    }
    return false
  }

  /** CDP 真实鼠标事件（PM/菜单交互用） */
  async function click(x, y, opts = {}) {
    const { button = 'left', clickCount = 1 } = opts
    await renderer.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: button === 'left' ? 1 : 2,
      clickCount,
    })
    await renderer.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    })
  }

  // ---------- 场景准备：编辑器挂载 + 挂载文件夹 ----------
  check(
    '编辑器挂载且 笔记A 已打开',
    await waitFor(
      `document.querySelector('#editor .milkdown, #editor .ProseMirror') && /笔记A/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
      20000,
    ),
  )

  // ⋯菜单的「文件」按钮指向 stub 的打开目录 → 挂载 notesDir（openFolder 内部会展开）
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { dialog } = req('electron')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(notesDir)}] })
    return 'stubbed'
  })()`)
  await ev(`document.getElementById('menu-files-btn').click()`)
  // ⋯菜单「文件」只展开侧边栏面板；点面板内「＋文件夹」→ stub 对话框返回 notesDir
  await ev(`document.getElementById('open-folder-btn').click()`)
  check(
    '文件夹挂载且树行出现',
    await waitFor(`document.querySelectorAll('#files-panel .tree-file').length >= 3`),
  )

  // ---------- ① 改名自动重写 ----------
  // 右键 笔记B 行 → 菜单「重命名」→ 行内输入 笔记D.md → Enter
  await ev(`(() => {
    const row = [...document.querySelectorAll('#files-panel .tree-file')].find(r => (r.title || '').endsWith('笔记B.md'))
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return !!row
  })()`)
  check(
    '文件树右键菜单弹出',
    await waitFor(
      `(() => { const m = document.querySelector('.file-context-menu'); return m && !m.hidden && [...m.querySelectorAll('button')].some(b => b.textContent.includes('重命名')) })()`,
    ),
  )
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.file-context-menu button')].find(b => b.textContent.includes('重命名'))
    btn.click()
    return true
  })()`)
  check(
    '行内重命名输入框出现',
    await waitFor(`!!document.querySelector('#files-panel .tree-inline-input')`),
  )
  await ev(`(() => {
    const input = document.querySelector('#files-panel .tree-inline-input')
    input.value = '笔记D.md'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  // 重命名 + 引用重写是异步链（preScan/重写/落盘），轮询磁盘产物
  let diskA = ''
  let renameOk = false
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    try {
      diskA = await readFile(aPath, 'utf-8')
    } catch {
      continue
    }
    const fenceBody = diskA.split('```')[1] ?? ''
    renameOk =
      diskA.includes('[[笔记D]]') &&
      diskA.includes('[[笔记D|别名样式]]') &&
      diskA.includes('[[笔记D#安装]]') &&
      fenceBody.includes('[[笔记B]]') &&
      (diskA.match(/\[\[笔记B\]\]/g) ?? []).length === 1
    if (renameOk) break
  }
  check('改名后引用自动重写（别名/标题锚保留）', renameOk, diskA.split('\n')[0])
  check('围栏代码块内的 [[笔记B]] 不被重写', (diskA.match(/\[\[笔记B\]\]/g) ?? []).length === 1)
  check(
    '重命名后旧文件不存在、新文件存在',
    !existsSync(bPath) && existsSync(path.join(notesDir, '笔记D.md')),
  )

  // ---------- ② 导出降级 ----------
  // 保存框 stub：按 filter 扩展名落盘到 workDir（仿 desktop-export-check）
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { dialog } = req('electron')
    const fs = req('node:fs')
    let n = 100
    dialog.showSaveDialog = async (...args) => {
      const opts = args.length > 1 ? args[1] : args[0]
      const ext = (opts && opts.filters && opts.filters[0] && opts.filters[0].extensions[0]) || 'bin'
      const filePath = ${JSON.stringify(workDir)} + '/exp-' + ++n + '.' + ext
      return { canceled: false, filePath }
    }
    return 'stubbed'
  })()`)

  await ev(`document.getElementById('menu-export-html-btn').click()`)
  let htmlPath = null
  for (let i = 0; i < 40 && !htmlPath; i++) {
    await sleep(250)
    for (const f of await readdir(workDir))
      if (f.endsWith('.html')) htmlPath = path.join(workDir, f)
  }
  const html = htmlPath ? await readFile(htmlPath, 'utf-8') : ''
  check(
    'HTML 导出：双链降级为 accent span（别名优先）',
    html.includes('<span class="wikilink">别名样式</span>'),
  )
  // 代码块内的 [[笔记B]] 属于源码字面（应保留）；双链目标 笔记D 不得以 [[ 形式残留
  const htmlNoCode = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '')
  check('HTML 导出：双链无 [[ 残留（代码块字面除外）', !htmlNoCode.includes('[['))

  await ev(`document.getElementById('menu-export-latex-btn').click()`)
  let texPath = null
  for (let i = 0; i < 40 && !texPath; i++) {
    await sleep(250)
    for (const f of await readdir(workDir)) if (f.endsWith('.tex')) texPath = path.join(workDir, f)
  }
  const tex = texPath ? await readFile(texPath, 'utf-8') : ''
  check(
    'LaTeX 导出：双链降级纯文本（别名样式保留）',
    tex.includes('别名样式') && tex.includes('ghost'),
  )
  // 代码块走 verbatim（[[笔记B]] 属源码字面）；重写后的双链不得以 [[ 形式残留
  const texNoCode = tex.replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/g, '')
  check('LaTeX 导出：双链无 [[ 残留（代码块字面除外）', !texNoCode.includes('[['))

  // ---------- ③ 分屏右键菜单 ----------
  await ev(`document.getElementById('menu-split-view-btn').click()`)
  check(
    '分屏模式进入（源码栏可见）',
    await waitFor(
      `(() => { const p = document.getElementById('src-pane'); return p && !p.hidden })()`,
    ),
  )

  /** 两侧可编辑状态的诊断值 */
  const editableState = () =>
    ev(`(() => ({
      pm: document.querySelector('#editor .ProseMirror')?.getAttribute('contenteditable'),
      cm: document.querySelector('#src-editor .cm-editor')?.getAttribute('contenteditable'),
    }))()`)

  // PM 侧第一段的屏幕坐标（真实鼠标事件落点）
  const pmPoint = await ev(`(() => {
    const p = document.querySelector('.page-scroll p')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) }
  })()`)
  // 双击选词（有选区才能看到完整格式化组）；CDP 双击后用 DOM 选区兜底确认
  await click(pmPoint.x, pmPoint.y, { clickCount: 2 })
  await ev(`(() => {
    const sel = getSelection()
    if (sel && sel.toString().length > 0) return true
    const p = document.querySelector('.page-scroll p')
    const textNode = p.firstChild
    sel.setBaseAndExtent(textNode, 0, textNode, 2)
    return true
  })()`)
  const selText = await ev(`getSelection().toString()`)
  console.log('  [probe] 选区文本:', JSON.stringify(selText))
  console.log('  [probe] 双击后 editable:', JSON.stringify(await editableState()))

  // 右键 PM 侧（此时 PM 可编辑 + 有选区）→ 完整格式化组
  await click(pmPoint.x, pmPoint.y, { button: 'right' })
  const pmEditableMenu = await ev(`(() => {
    const m = document.getElementById('context-menu')
    if (!m || m.hidden) return null
    return [...m.querySelectorAll('[data-cm-action]')].filter(b => !b.hidden).map(b => b.dataset.cmAction)
  })()`)
  check(
    '分屏 PM 侧（可编辑+选区）右键：完整格式化组',
    Array.isArray(pmEditableMenu) &&
      pmEditableMenu.includes('bold') &&
      pmEditableMenu.includes('cut'),
    JSON.stringify(pmEditableMenu),
  )
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)

  // 点源码侧使 CM 成为活动侧，PM 转只读跟随
  const srcPoint = await ev(`(() => {
    const r = document.getElementById('src-editor').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) }
  })()`)
  await click(srcPoint.x, srcPoint.y)
  console.log('  [probe] 点源码侧后 editable:', JSON.stringify(await editableState()))

  // 右键源码侧（此时源码侧可编辑、无选区）→ 仅粘贴
  await click(srcPoint.x, srcPoint.y, { button: 'right' })
  const srcMenu = await ev(`(() => {
    const m = document.getElementById('context-menu')
    if (!m || m.hidden) return null
    return [...m.querySelectorAll('[data-cm-action]')].filter(b => !b.hidden).map(b => b.dataset.cmAction)
  })()`)
  check(
    '分屏源码侧（可编辑无选区）右键：仅粘贴、无格式化组',
    Array.isArray(srcMenu) && srcMenu.length === 1 && srcMenu[0] === 'paste',
    JSON.stringify(srcMenu),
  )
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)

  // 右键 PM 侧（只读跟随 + 之前保留的选区）→ 仅复制。
  // 注意：真实右键的 mousedown 会先把只读侧切回可编辑（点哪侧哪侧可编辑的
  // 既有设计），因此退化菜单走「无 mousedown 的合成 contextmenu」——与键盘
  // 菜单键的触发路径一致。
  await ev(`(() => {
    const p = document.querySelector('.page-scroll p')
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return true
  })()`)
  const pmReadonlyMenu = await ev(`(() => {
    const m = document.getElementById('context-menu')
    if (!m || m.hidden) return null
    return [...m.querySelectorAll('[data-cm-action]')].filter(b => !b.hidden).map(b => b.dataset.cmAction)
  })()`)
  check(
    '分屏只读跟随侧（PM）右键：仅有复制',
    Array.isArray(pmReadonlyMenu) && pmReadonlyMenu.length === 1 && pmReadonlyMenu[0] === 'copy',
    JSON.stringify(pmReadonlyMenu),
  )
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
} catch (err) {
  check('探针执行无异常', false, String(err))
} finally {
  if (child) await killTree(child)
  await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(notesDir, { recursive: true, force: true }).catch(() => {})
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
}

const passed = results.filter(Boolean).length
console.log(`\n===== 汇总：${passed}/${results.length} 断言通过 =====`)
process.exit(passed === results.length ? 0 : 1)
