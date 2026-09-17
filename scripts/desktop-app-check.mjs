/**
 * 桌面端主链路 + 可靠性设施 E2E 检查（与单测互补：单测验逻辑，本脚本验真实链路）。
 *
 * 驱动真实的 dist 产物 Electron（无界面桩件，仅把原生对话框替换为固定输入/输出，
 * 文件读写、菜单分发、编辑器、IPC、crashReporter、日志落盘全部走真实代码），
 * 通过 Chrome DevTools Protocol（渲染层 9222 / 主进程 --inspect 9229）操作与断言。
 *
 * 覆盖 10 个场景：
 *  1. 首启为空白未命名文档，且无恢复副本
 *  2. 菜单「打开」加载真实磁盘文档
 *  3. 编辑后脏标记出现、恢复副本写入 localStorage
 *  4. 菜单「保存」写回磁盘、脏标记清除、恢复副本清除
 *  5. 菜单「另存为」产出新文件并切换关联路径
 *  6. 未保存关闭走原生确认框，选「取消」窗口存活
 *  7. 渲染层未捕获异常经 IPC 落盘到 TMD_HOME_DIR/.tmd/logs（JSONL）
 *  8. 渲染进程原生崩溃（webContents.crash）触发 child-process-gone 日志
 *  9. SIGKILL 强杀后同 profile 重启：恢复副本内容还原；上次 renderer dump 被登记
 * 10. 主进程原生崩溃（process.crash）非零退出并产出 minidump
 *
 * 隔离缝（不碰用户日常环境）：
 * - 独立 --user-data-dir（配置 / localStorage）
 * - TMD_HOME_DIR 重定位 ~/.tmd（日志与崩溃转储）
 * - 工作目录在系统临时目录
 *
 * 退出码：0 全部通过；1 有断言失败；2 脚本自身异常。
 * --keep：保留临时目录与崩溃现场便于排查。
 *
 * @author chiangyang
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Cdp,
  MAIN_PORT,
  RENDERER_PORT,
  cleanupElectron,
  killTree,
  sleep,
  spawnApp,
  waitExit,
  waitForPortsFree,
  waitForTarget,
} from './lib/desktop-harness.mjs'

/** 仓库根目录（本文件位于 scripts/ 下） */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** 临时工作目录：测试文档 / 另存产物 / 隔离 profile / 重定位的 ~/.tmd */
const WORK = join(tmpdir(), 'tmd-app-check')
const PROFILE = join(WORK, 'profile')
const HOME_DIR = join(WORK, 'home')
const DOCS_DIR = join(WORK, 'docs')
const MD_PATH = join(DOCS_DIR, 'sample.md')
const COPY_PATH = join(WORK, 'copy-1.md')
/** 日志目录（与 electron/logger.cjs 的 logsDir 结构一致） */
const LOGS_DIR = join(HOME_DIR, '.tmd', 'logs')
/** 崩溃转储目录（与 logger.cjs 的 crashDumpsDir 结构一致） */
const DUMPS_DIR = join(HOME_DIR, '.tmd', 'crash-dumps')
/** 历史版本目录（与 history.cjs 的 historyDir 结构一致） */
const HISTORY_DIR = join(HOME_DIR, '.tmd', 'history')
/** 渲染层恢复副本键名（须与 src/store.ts DOC_KEY 一致） */
const DOC_KEY = 'tmd:doc:v1'

const EDIT_MARKER = 'E2E-EDIT-MARKER-7f3a'
const RECOVER_MARKER = 'E2E-RECOVER-MARKER-9c2b'
const RENDER_ERROR_MARKER = 'tmd-e2e-render-error-marker'

const KEEP = process.argv.includes('--keep')
const results = []

/**
 * @param {string} name
 * @param {boolean} passed
 * @param {string} [detail]
 */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}
/**
 * 诊断项（环境差异导致的软断言）：不影响退出码，仅记录。
 * @param {string} name
 * @param {string} detail
 */
function diag(name, detail) {
  results.push({ name, passed: true, detail, diagnostic: true })
  console.log(`DIAG  ${name} :: ${detail}`)
}

// ---------------------------------------------------------------------------
// 主进程 / 渲染层操作辅助
// ---------------------------------------------------------------------------

/**
 * 启动应用并完成两侧 CDP 连接与对话框 stub 注入。
 * @param {string} profile
 * @param {string} homeDir
 * @returns {Promise<{ child: import('node:child_process').ChildProcessWithoutNullStreams, main: Cdp, renderer: Cdp }>}
 */
async function launch(profile, homeDir) {
  // 崩溃实例退出后端口释放有窗口，启动前以端口空闲为确定性闸门
  await waitForPortsFree()
  const child = spawnApp({
    repo: REPO,
    profile,
    env: { TMD_HOME_DIR: homeDir },
  })
  const nodeTarget = await waitForTarget(
    MAIN_PORT,
    (t) => t.type === 'node' || t.url?.startsWith('file:') || !!t.webSocketDebuggerUrl,
  )
  const main = new Cdp(nodeTarget.webSocketDebuggerUrl)
  await main.connect()
  await main.send('Runtime.enable')

  await installDialogStubs(main)

  const page = await waitForTarget(
    RENDERER_PORT,
    (t) => t.type === 'page' && /index\.html/.test(t.url),
  )
  const renderer = new Cdp(page.webSocketDebuggerUrl)
  await renderer.connect()
  await renderer.send('Runtime.enable')
  return { child, main, renderer }
}

/**
 * 主进程 stub：打开/保存对话框换固定路径；消息框返回值由 global.__tmdE2E 控制
 * （消费式：读取一次后自动回落 0＝确认/放弃）。其余链路全真实。
 * @param {Cdp} main
 */
async function installDialogStubs(main) {
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { dialog } = req('electron')
    const fs = req('node:fs')
    global.__tmdE2E = { nextMsgResponse: 0 }
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [${JSON.stringify(MD_PATH)}],
    })
    dialog.showSaveDialog = async () => {
      fs.mkdirSync(${JSON.stringify(WORK)}, { recursive: true })
      return { canceled: false, filePath: ${JSON.stringify(COPY_PATH)} }
    }
    dialog.showMessageBox = async () => {
      const response = global.__tmdE2E.nextMsgResponse
      global.__tmdE2E.nextMsgResponse = 0
      return { response, checkboxChecked: false }
    }
    return true
  })()`)
}

/**
 * 安排下一次 showMessageBox 的返回（1＝取消，对齐 close 确认框 cancelId）。
 * @param {Cdp} main
 * @param {number} response
 */
async function setNextMessageBox(main, response) {
  await main.evalJson(`global.__tmdE2E.nextMsgResponse = ${response}`)
}

/**
 * 点击「文件」菜单中的指定动作（按中英文 label 匹配，避免依赖系统语言）。
 * @param {Cdp} main
 * @param {'open' | 'save' | 'save-as'} action
 */
async function clickFileAction(main, action) {
  await main.evalJson(`(() => {
    const action = ${JSON.stringify(action)}
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { Menu } = req('electron')
    const m = Menu.getApplicationMenu()
    const fileMenu = m.items.find(
      (i) => i.submenu && i.submenu.items.some((s) => /打开|Open/.test(s.label || '')),
    )
    const match = (label) => {
      const s = label || ''
      if (action === 'history') return /历史版本|Version History/.test(s)
      if (action === 'open') return /打开|Open/.test(s) && !/文件夹|Folder/.test(s)
      if (action === 'save') return /保存|Save/.test(s) && !/另存|Save As/.test(s)
      return /另存为|Save As/.test(s)
    }
    const item = fileMenu.submenu.items.find((s) => match(s.label))
    if (!item) throw new Error('未找到菜单项: ' + action)
    item.click()
    return item.label
  })()`)
}

/**
 * 等渲染层 boot 完成（菜单 DOM 就绪后再等编辑器挂载）。
 * @param {Cdp} renderer
 */
async function waitRendererReady(renderer) {
  for (let i = 0; i < 60; i++) {
    const ready = await renderer.evalJson(
      `!!document.querySelector('#menu-export-word-btn') && !!document.querySelector('#editor .ProseMirror')`,
    )
    if (ready === true) return
    await sleep(250)
  }
  throw new Error('渲染层就绪超时')
}

/**
 * 在编辑器获得焦点后经 CDP 插入文本（触发真实 input 事件链）。
 * @param {Cdp} renderer
 * @param {string} text
 */
async function insertText(renderer, text) {
  await renderer.evalJson(`document.querySelector('#editor .ProseMirror')?.focus()`)
  await renderer.send('Input.insertText', { text })
}

/**
 * 读取编辑器正文纯文本。
 * @param {Cdp} renderer
 * @returns {Promise<string>}
 */
async function editorText(renderer) {
  const v = await renderer.evalJson(
    `document.querySelector('#editor .ProseMirror')?.innerText || ''`,
  )
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// 日志与崩溃转储读取（脚本侧直接读磁盘，验证 TMD_HOME_DIR 重定位生效）
// ---------------------------------------------------------------------------

/** @returns {Array<Record<string, unknown> & {file: string}>} */
function readLogEntries() {
  if (!existsSync(LOGS_DIR)) return []
  return readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((file) =>
      readFileSync(join(LOGS_DIR, file), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return { .../** @type {Record<string, unknown>} */ (JSON.parse(line)), file }
          } catch {
            return null
          }
        })
        .filter(Boolean),
    )
}

/**
 * 轮询等待满足条件的日志行。
 * @param {(e: Record<string, unknown>) => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitForLog(predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = readLogEntries().find(predicate)
    if (hit) return hit
    await sleep(300)
  }
  return null
}

/**
 * 递归列出崩溃目录中的 minidump（crashpad 数据库把 .dmp 放在 pending/ 等子目录）。
 * @param {string} [dir]
 * @param {string} [prefix]
 * @returns {{ name: string, size: number, mtimeMs: number }[]}
 */
function listDumps(dir = DUMPS_DIR, prefix = '') {
  if (!existsSync(dir)) return []
  /** @type {{ name: string, size: number, mtimeMs: number }[]} */
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...listDumps(abs, rel))
    } else if (ent.isFile() && ent.name.endsWith('.dmp')) {
      const st = statSync(abs)
      out.push({ name: rel, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/**
 * 发出但不等待结果的 CDP 求值：用于命令会让目标立即崩溃、连接随之断开的场景
 * （process.crash 永远不会返回响应，等待只会吃到 60s 超时）。
 * id 固定 0：不进入 pending 表，迟来的响应在 onmessage 中被静默丢弃。
 * @param {Cdp} cdp
 * @param {string} expression
 */
function evalNoWait(cdp, expression) {
  cdp.ws.send(
    JSON.stringify({
      id: 0,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true },
    }),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(REPO, 'dist', 'index.html'))) {
    console.error('未找到 dist 构建产物，请先执行：npm run build')
    process.exit(2)
  }

  // 上一轮残留先清理（.bin/electron 是包装脚本，杀包装层不会杀掉真正的 Electron）
  cleanupElectron()
  await waitForPortsFree()

  await rm(WORK, { recursive: true, force: true })
  await mkdir(DOCS_DIR, { recursive: true })
  await writeFile(
    MD_PATH,
    '# TMD 主链路验证文档\n\n用于桌面主链路 E2E：打开 → 编辑 → 保存 → 另存为 → 崩溃恢复。\n',
    'utf-8',
  )

  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child1 = null
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child2 = null
  /** @type {Cdp | null} */
  let mainCdp = null
  /** @type {Cdp | null} */
  let rendererCdp = null
  /** @type {Cdp | null} */
  let mainCdp2 = null

  try {
    // === 启动第一实例 ===
    ;({ child: child1, main: mainCdp, renderer: rendererCdp } = await launch(PROFILE, HOME_DIR))
    await waitRendererReady(rendererCdp)

    // ---------- 场景 1：首启空白 ----------
    const blankInfo = await rendererCdp.evalJson(`JSON.stringify({
      tabCount: document.querySelectorAll('.tab').length,
      text: (document.querySelector('#editor .ProseMirror')?.innerText || '').trim(),
      doc: localStorage.getItem(${JSON.stringify(DOC_KEY)})
    })`)
    const blank = JSON.parse(blankInfo)
    check(
      '场景1 首启为单个空白未命名文档且无恢复副本',
      blank.tabCount === 1 && blank.text === '' && blank.doc === null,
      blankInfo,
    )

    // ---------- 场景 2：菜单打开真实文档 ----------
    await clickFileAction(mainCdp, 'open')
    let opened = false
    for (let i = 0; i < 40; i++) {
      const tab = /** @type {string} */ (
        await rendererCdp.evalJson(`document.querySelector('.tab.active')?.textContent || ''`)
      )
      const text = await editorText(rendererCdp)
      if (/sample\.md/.test(tab) && text.includes('主链路验证文档')) {
        opened = true
        break
      }
      await sleep(250)
    }
    check('场景2 菜单打开后标签与正文来自磁盘文档', opened)

    // ---------- 场景 3：编辑 → 脏标记 + 恢复副本 ----------
    await insertText(rendererCdp, EDIT_MARKER)
    let dirtyAndSaved = false
    let editDetail = ''
    for (let i = 0; i < 40; i++) {
      editDetail = /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          tabText: document.querySelector('.tab.active')?.textContent?.trim() || '',
          text: document.querySelector('#editor .ProseMirror')?.innerText || '',
          doc: localStorage.getItem(${JSON.stringify(DOC_KEY)}) || ''
        })`)
      )
      const s = JSON.parse(editDetail)
      if (
        s.tabText.startsWith('•') &&
        s.text.includes(EDIT_MARKER) &&
        s.doc.includes(EDIT_MARKER)
      ) {
        dirtyAndSaved = true
        break
      }
      await sleep(250)
    }
    check('场景3 编辑后脏标记出现且恢复副本已写入', dirtyAndSaved, editDetail)

    // ---------- 场景 4：保存写回磁盘 ----------
    await clickFileAction(mainCdp, 'save')
    let savedOk = false
    let saveDetail = ''
    for (let i = 0; i < 40; i++) {
      const disk = existsSync(MD_PATH) ? await readFile(MD_PATH, 'utf-8').catch(() => '') : ''
      saveDetail = /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          tabText: document.querySelector('.tab.active')?.textContent?.trim() || '',
          doc: localStorage.getItem(${JSON.stringify(DOC_KEY)})
        })`)
      )
      const s = JSON.parse(saveDetail)
      if (disk.includes(EDIT_MARKER) && !s.tabText.startsWith('•') && s.doc === null) {
        savedOk = true
        saveDetail = `磁盘 ${disk.length} 字节，tab=${s.tabText}`
        break
      }
      await sleep(250)
    }
    check('场景4 保存写回磁盘、脏标记清除、恢复副本清除', savedOk, saveDetail)

    // ---------- 场景 5：另存为 ----------
    await clickFileAction(mainCdp, 'save-as')
    let savedAsOk = false
    let saveAsDetail = ''
    for (let i = 0; i < 40; i++) {
      if (existsSync(COPY_PATH)) {
        const copyContent = await readFile(COPY_PATH, 'utf-8').catch(() => '')
        saveAsDetail = /** @type {string} */ (
          await rendererCdp.evalJson(
            `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
          )
        )
        if (copyContent.includes(EDIT_MARKER) && /copy-1\.md/.test(saveAsDetail)) {
          savedAsOk = true
          break
        }
      }
      await sleep(250)
    }
    check('场景5 另存为产出新文件且标签切换关联路径', savedAsOk, saveAsDetail)

    // 另存为后激活标签是 copy-1.md（新文件、无历史），先切回 sample.md：
    // 同路径已打开 → openFromData 走 activateTab 去重，不开新标签
    await clickFileAction(mainCdp, 'open')
    for (let i = 0; i < 40; i++) {
      const name = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
        )
      )
      if (/sample\.md/.test(name)) break
      await sleep(250)
    }

    // ---------- 场景 5b：历史版本（写盘前自动快照） ----------
    // 场景 4 的保存覆盖了磁盘旧内容，主进程应在写盘前把它存进 ~/.tmd/history。
    // 目录名是路径哈希，故这里只按「有目录且有 .md」计数，不假设具体名字。
    const historyDirs = existsSync(HISTORY_DIR)
      ? readdirSync(HISTORY_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
      : []
    const snapCount = historyDirs.reduce(
      (sum, d) =>
        sum + readdirSync(join(HISTORY_DIR, d.name)).filter((f) => f.endsWith('.md')).length,
      0,
    )
    check(
      '场景5b 写盘前自动留存旧内容快照（~/.tmd/history，随 TMD_HOME_DIR 重定位）',
      historyDirs.length === 1 && snapCount >= 1,
      `历史目录 ${historyDirs.length} 个，快照 ${snapCount} 个`,
    )

    // ---------- 场景 5c：菜单打开历史面板并列出快照 ----------
    await clickFileAction(mainCdp, 'history')
    /** @type {{ hidden?: boolean, items?: number, status?: string } | null} */
    let panelState = null
    for (let i = 0; i < 40; i++) {
      panelState = JSON.parse(
        /** @type {string} */ (
          await rendererCdp.evalJson(`JSON.stringify({
            hidden: document.getElementById('history-overlay')?.hidden,
            items: document.querySelectorAll('#history-list .history-item').length,
            status: document.getElementById('history-status')?.textContent || ''
          })`)
        ),
      )
      if (panelState.hidden === false && (panelState.items ?? 0) > 0) break
      await sleep(250)
    }
    check(
      '场景5c 菜单打开历史面板并列出快照',
      panelState?.hidden === false && (panelState?.items ?? 0) >= 1,
      JSON.stringify(panelState),
    )

    // ---------- 场景 5d：选中快照 → 预览保存前的旧内容 ----------
    await rendererCdp.evalJson(`document.querySelector('#history-list .history-item')?.click()`)
    let preview = ''
    for (let i = 0; i < 40; i++) {
      preview = /** @type {string} */ (
        await rendererCdp.evalJson(`document.getElementById('history-preview')?.textContent || ''`)
      )
      if (preview.includes('主链路验证文档')) break
      await sleep(250)
    }
    check(
      '场景5d 预览内容为保存前的旧版本（不含本次编辑标记）',
      preview.includes('主链路验证文档') && !preview.includes(EDIT_MARKER),
      `预览 ${preview.length} 字符`,
    )

    // ---------- 场景 5e：恢复快照 → 载入编辑器并置脏 ----------
    const restoreEnabled =
      (await rendererCdp.evalJson(`!document.getElementById('history-restore-btn')?.disabled`)) ===
      true
    await rendererCdp.evalJson(`document.getElementById('history-restore-btn')?.click()`)
    /** @type {{ hidden?: boolean, text?: string, tab?: string } | null} */
    let restoredInfo = null
    for (let i = 0; i < 40; i++) {
      restoredInfo = JSON.parse(
        /** @type {string} */ (
          await rendererCdp.evalJson(`JSON.stringify({
            hidden: document.getElementById('history-overlay')?.hidden,
            text: document.querySelector('#editor .ProseMirror')?.innerText || '',
            tab: document.querySelector('.tab.active')?.textContent?.trim() || ''
          })`)
        ),
      )
      if (restoredInfo.hidden === true && !(restoredInfo.text ?? '').includes(EDIT_MARKER)) break
      await sleep(250)
    }
    check(
      '场景5e 恢复快照到编辑器并置脏、面板自动关闭',
      restoreEnabled &&
        restoredInfo?.hidden === true &&
        !(restoredInfo?.text ?? '').includes(EDIT_MARKER) &&
        (restoredInfo?.tab ?? '').startsWith('•'),
      JSON.stringify({ restoreEnabled, tab: restoredInfo?.tab, len: restoredInfo?.text?.length }),
    )

    // 恢复只改编辑器：磁盘仍是已保存的含编辑标记版本（是否覆盖由用户后续保存决定）
    const diskAfterRestore = await readFile(MD_PATH, 'utf-8').catch(() => '')
    check(
      '场景5f 恢复不直接改写磁盘（仍需用户显式保存）',
      diskAfterRestore.includes(EDIT_MARKER),
      `磁盘 ${diskAfterRestore.length} 字节`,
    )

    // ---------- 场景 6：未保存关闭选「取消」 ----------
    // 再制造一处未保存修改（也是场景 9 崩溃恢复的验证文本）
    await insertText(rendererCdp, RECOVER_MARKER)
    for (let i = 0; i < 40; i++) {
      const doc = /** @type {string} */ (
        await rendererCdp.evalJson(`localStorage.getItem(${JSON.stringify(DOC_KEY)}) || ''`)
      )
      const tab = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
        )
      )
      if (doc.includes(RECOVER_MARKER) && tab.startsWith('•')) break
      await sleep(250)
    }
    // 等待脏标记 IPC 到达主进程
    await sleep(600)
    await setNextMessageBox(mainCdp, 1) // cancelId：取消关闭
    await mainCdp.evalJson(
      `(typeof require === 'function' ? require : global.process.mainModule.require)('electron').BrowserWindow.getAllWindows()[0].close()`,
    )
    await sleep(2000)
    // rendererDirty 是主进程闭包变量，这里以窗口数量与渲染层存活侧证拦截生效
    const cancelInfo = await mainCdp.evalJson(`JSON.stringify({
      windows: (typeof require === 'function' ? require : global.process.mainModule.require)('electron').BrowserWindow.getAllWindows().length
    })`)
    // 渲染层仍可求值（页面未销毁）且主进程窗口仍在
    const rendererAlive =
      (await rendererCdp.evalJson(`!!document.querySelector('#editor .ProseMirror')`)) === true
    check(
      '场景6 未保存关闭选取消后窗口与文档存活',
      JSON.parse(cancelInfo).windows === 1 && rendererAlive,
      cancelInfo,
    )

    // ---------- 场景 7：渲染层异常落盘 ----------
    await rendererCdp.evalJson(`window.dispatchEvent(new ErrorEvent('error', {
      message: ${JSON.stringify(RENDER_ERROR_MARKER)},
      error: new Error(${JSON.stringify(RENDER_ERROR_MARKER)}),
      filename: 'e2e-marker.js',
      lineno: 42,
      colno: 7
    }))`)
    const renderErrLog = await waitForLog(
      (e) =>
        e.source === 'renderer' &&
        typeof e.message === 'string' &&
        e.message.includes(RENDER_ERROR_MARKER),
    )
    // 能在重定位的 HOME_DIR 日志目录中读到该行，本身即证明 TMD_HOME_DIR 生效
    check(
      '场景7 渲染层异常经 IPC 落盘到 TMD_HOME_DIR（含文件名与行列号）',
      !!renderErrLog &&
        typeof renderErrLog.file === 'string' &&
        renderErrLog.file.endsWith('.jsonl') &&
        renderErrLog.lineno === 42 &&
        renderErrLog.filename === 'e2e-marker.js',
      renderErrLog
        ? JSON.stringify({ file: renderErrLog.file, lineno: renderErrLog.lineno })
        : '未找到日志行',
    )

    // ---------- 场景 8：渲染进程原生崩溃 ----------
    // Electron 44 方法名为 forcefullyCrashRenderer（旧版 forceCrash / crash），多版兼容；
    // 官方文档：reason 可能是 crashed 或 killed，二者都算渲染进程异常退出。
    // 崩溃后渲染层 CDP 断开，后续渲染层断言在第二实例进行
    await mainCdp.evalJson(`(() => {
      const { BrowserWindow } = (typeof require === 'function' ? require : global.process.mainModule.require)('electron')
      const wc = BrowserWindow.getAllWindows()[0].webContents
      const crash = wc.forcefullyCrashRenderer || wc.forceCrash || wc.crash
      crash.call(wc)
      return true
    })()`)
    const goneLog = await waitForLog(
      (e) => e.source === 'child-process' && /(crashed|killed)/.test(String(e.message ?? '')),
    )
    check(
      '场景8 渲染进程崩溃记录 child-process-gone（type renderer / reason crashed|killed）',
      !!goneLog &&
        /renderer/i.test(String(goneLog.message ?? '')) &&
        ['crashed', 'killed'].includes(String(goneLog.reason ?? '')),
      goneLog
        ? JSON.stringify({ message: goneLog.message, reason: goneLog.reason })
        : '未找到日志行',
    )
    // 给 crashpad 一点落盘时间
    await sleep(2500)
    const dumpsAfterRendererCrash = listDumps()

    // ---------- 场景 9：SIGKILL 后重启恢复 + dump 登记 ----------
    killTree(child1)
    child1 = null
    await sleep(2000)
    cleanupElectron()

    ;({ child: child2, main: mainCdp2, renderer: rendererCdp } = await launch(PROFILE, HOME_DIR))
    await waitRendererReady(rendererCdp)

    let recovered = false
    let recoverDetail = ''
    for (let i = 0; i < 40; i++) {
      recoverDetail = JSON.stringify({
        tabCount: await rendererCdp.evalJson(`document.querySelectorAll('.tab').length`),
        text: await editorText(rendererCdp),
      })
      const s = JSON.parse(recoverDetail)
      if (typeof s.text === 'string' && s.text.includes(RECOVER_MARKER)) {
        recovered = true
        break
      }
      await sleep(250)
    }
    check('场景9 强杀后重启从恢复副本还原未保存内容', recovered, recoverDetail)

    // 上次运行的 renderer minidump 应在启动扫描时登记（若环境产出了 dump）
    if (dumpsAfterRendererCrash.length > 0) {
      const names = new Set(dumpsAfterRendererCrash.map((d) => d.name))
      const nativeLog = await waitForLog(
        (e) =>
          e.source === 'native-crash' &&
          names.has(String(/** @type {{dump?: unknown}} */ (e).dump ?? '')),
      )
      check(
        '场景9b 启动时登记上次遗留的 renderer minidump',
        !!nativeLog,
        nativeLog ? String(nativeLog.message) : '未找到 native-crash 登记行',
      )
    } else {
      diag('场景9b 渲染器崩溃未产出 minidump（未打包环境可能无 dump），跳过登记断言')
    }

    // ---------- 场景 10：主进程原生崩溃 ----------
    const beforeNames = new Set(listDumps().map((d) => d.name))
    const crashAt = Date.now()
    // process.crash() 无响应（进程当场死亡），只投递命令、不等待
    evalNoWait(mainCdp2, `process.crash()`)
    const exit = await waitExit(child2, 15000).catch((err) => {
      diag('场景10 等待退出异常', String(err && err.message))
      return null
    })
    child2 = null
    const nonZeroExit = !!exit && (exit.code !== 0 || exit.signal !== null)
    check('场景10 主进程原生崩溃非零退出', nonZeroExit, exit ? JSON.stringify(exit) : '未捕获退出')
    // 等 crashpad 完成落盘
    await sleep(2500)
    const newDumps = listDumps().filter((d) => !beforeNames.has(d.name) && d.size > 0)
    if (newDumps.length > 0) {
      check(
        '场景10b 崩溃转储目录新增非空 minidump',
        newDumps.some((d) => d.mtimeMs >= crashAt - 5000),
        newDumps.map((d) => `${d.name}(${d.size}B)`).join(', '),
      )
    } else {
      diag('场景10b 未检测到新增 minidump（未打包环境差异），仅以非零退出为准')
    }
  } catch (err) {
    console.error('\n脚本异常：', err)
    if (child1) killTree(child1)
    if (child2) killTree(child2)
    cleanupElectron()
    mainCdp?.close()
    mainCdp2?.close()
    rendererCdp?.close()
    process.exit(2)
  }

  // 收尾（场景 10 后主进程应已自行崩溃退出，这里仅做兜底）
  if (child1) killTree(child1)
  if (child2) killTree(child2)
  cleanupElectron()
  mainCdp?.close()
  mainCdp2?.close()
  rendererCdp?.close()

  const failed = results.filter((r) => !r.passed)
  const total = results.filter((r) => !r.diagnostic)
  console.log(`\n===== 汇总：${total.length - failed.length}/${total.length} 断言通过 =====`)
  if (!KEEP) {
    await rm(WORK, { recursive: true, force: true })
    console.log('临时目录已清理（--keep 可保留：' + WORK + '）')
  } else {
    console.log('保留临时目录：' + WORK)
  }
  process.exit(failed.length ? 1 : 0)
}

main()
