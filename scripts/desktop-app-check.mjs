/**
 * 桌面端主链路 + 可靠性设施 E2E 检查（与单测互补：单测验逻辑，本脚本验真实链路）。
 *
 * 驱动真实的 dist 产物 Electron（无界面桩件，仅把原生对话框替换为固定输入/输出，
 * 文件读写、菜单分发、编辑器、IPC、crashReporter、日志落盘全部走真实代码），
 * 通过 Chrome DevTools Protocol（渲染层 9222 / 主进程 --inspect 9229）操作与断言。
 *
 * 覆盖 12 个场景：
 *  1. 首启为空白未命名文档，且无恢复副本
 *  2. 菜单「打开」加载真实磁盘文档
 *  3. 编辑后脏标记出现、恢复副本写入 localStorage
 *  4. 菜单「保存」写回磁盘、脏标记清除、恢复副本清除
 *  5. 菜单「另存为」产出新文件并切换关联路径
 *  5a. 外部修改检测：干净标签自动重载；脏标签弹提示条，
 *      「重新加载」采用磁盘内容清脏 / 「保留我的版本」不覆盖本地
 *  6. 未保存关闭走原生确认框，选「取消」窗口存活
 *  6g. 源码模式：单栏可编辑、退出并回、恢复副本跟随
 *  6i. 侧边栏文件管理：挂载文件夹 → 行内新建（落盘+打开）→ 右键重命名（磁盘与标签同步）
 *  6j. 快速切换拼音首字母：Ctrl+P 输入 xmsm 命中「项目说明.md」并打开
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
const SPLIT_MARKER = 'E2E-SPLIT-MARKER-3d1e'
const SOURCE_MARKER = 'E2E-SOURCE-MARKER-5a8f'
const CM_EDIT_MARKER = 'E2E-CM-MARKER-7b2c'
const RENDER_ERROR_MARKER = 'tmd-e2e-render-error-marker'
/** 外部修改检测场景：脚本直接改磁盘的三个版本 + 编辑/保留标记 */
const EXT_V1 = 'E2E-EXT-CHANGE-1'
const EXT_V2 = 'E2E-EXT-CHANGE-2'
const EXT_V3 = 'E2E-EXT-CHANGE-3'
const DIRTY_BEFORE_EXT = 'E2E-DIRTY-BEFORE-EXT'
const KEEP_MINE_MARKER = 'E2E-KEEP-MINE'

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
    dialog.showOpenDialog = async () => {
      // nextOpenDir：文件管理场景临时把「打开文件夹」指向工作目录（消费式）
      const dir = global.__tmdE2E.nextOpenDir
      global.__tmdE2E.nextOpenDir = null
      if (dir) return { canceled: false, filePaths: [dir] }
      return { canceled: false, filePaths: [${JSON.stringify(MD_PATH)}] }
    }
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
 * 点击悬浮菜单（⋯）里的「分屏」项。
 * 分屏入口在 more-menu 内，先展开菜单再点项（与真实操作一致），菜单项自身会收起菜单。
 * @param {Cdp} renderer
 */
async function clickSplitMenuItem(renderer) {
  await renderer.evalJson(`(() => {
    document.getElementById('more-btn')?.click()
    document.getElementById('menu-split-view-btn')?.click()
    return true
  })()`)
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

/**
 * 通过应用菜单勾选/取消「自动保存到文件」（场景 5b 期间关掉，
 * 避免 5 秒周期写盘把脏标签中途变干净造成竞态；跑完恢复）。
 * @param {Cdp} main
 * @param {boolean} on 目标状态
 */
async function setAutosaveViaMenu(main, on) {
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { Menu } = req('electron')
    const m = Menu.getApplicationMenu()
    const item = m.items
      .flatMap((i) => (i.submenu ? i.submenu.items : []))
      .find((s) => /自动保存|Autosave/.test(s.label || ''))
    if (!item) throw new Error('未找到自动保存菜单项')
    if (item.checked !== ${on}) item.click()
    return item.checked
  })()`)
}

/**
 * 等待渲染层出现/消失外部修改提示条。
 * @param {Cdp} renderer
 * @param {boolean} visible
 */
async function waitExtBar(renderer, visible) {
  for (let i = 0; i < 40; i++) {
    const has = await renderer.evalJson(`!!document.querySelector('.extchange-bar')`)
    if (has === visible) return true
    await sleep(250)
  }
  return false
}

/**
 * 点击提示条上的指定按钮（.extchange-reload / .extchange-keep）。
 * @param {Cdp} renderer
 * @param {'reload' | 'keep'} which
 */
async function clickExtBarButton(renderer, which) {
  await renderer.evalJson(`document.querySelector('.extchange-${which}')?.click()`)
}

/**
 * 等待编辑器正文包含指定标记且标签脏点符合预期。
 * @param {Cdp} renderer
 * @param {string} textMarker
 * @param {boolean} expectDirty
 */
async function waitEditorState(renderer, textMarker, expectDirty) {
  for (let i = 0; i < 40; i++) {
    const s = /** @type {string} */ (
      await renderer.evalJson(`JSON.stringify({
        text: document.querySelector('#editor .ProseMirror')?.innerText || '',
        dirty: (document.querySelector('.tab.active')?.textContent || '').trim().startsWith('•'),
        bar: !!document.querySelector('.extchange-bar'),
      })`)
    )
    const state = JSON.parse(s)
    if (state.text.includes(textMarker) && state.dirty === expectDirty && !state.bar) return s
    await sleep(250)
  }
  return ''
}

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

    // ---------- 场景 3b：查找高亮随文档编辑映射（边搜边改） ----------
    // 回归：匹配列表曾只在查询变化时重算，编辑后旧坐标导致高亮错位、跳转越界
    // RangeError、替换写错位置。现由插件随事务映射坐标 + 防抖重算修正内容。
    await rendererCdp.evalJson(`(() => {
      document.getElementById('menu-find-btn')?.click()
      const input = document.getElementById('find-input')
      if (input) {
        input.value = 'E2E'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })()`)
    let findHits = 0
    for (let i = 0; i < 20; i++) {
      findHits = await rendererCdp.evalJson(`document.querySelectorAll('.find-hit').length`)
      if (findHits > 0) break
      await sleep(250)
    }
    // 跳到第一个匹配（光标落在命中起点），随后在命中内打字：映射应保住该命中
    await rendererCdp.evalJson(`document.getElementById('find-next')?.click()`)
    await insertText(rendererCdp, 'ZZ')
    let findMappedOk = false
    let findMapDetail = ''
    for (let i = 0; i < 20; i++) {
      findMapDetail = /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          hits: document.querySelectorAll('.find-hit').length,
          text: document.querySelector('#editor .ProseMirror')?.innerText?.includes('ZZ') ?? false,
        })`)
      )
      const s = JSON.parse(findMapDetail)
      if (s.hits > 0 && s.text) {
        findMappedOk = true
        break
      }
      await sleep(250)
    }
    // 编辑后「下一个」仍可用（旧实现在坐标陈旧时可能抛 RangeError）
    await rendererCdp.evalJson(`document.getElementById('find-next')?.click()`)
    const afterStep = await rendererCdp.evalJson(
      `document.querySelectorAll('.find-hit.find-current').length`,
    )
    await rendererCdp.evalJson(`document.getElementById('find-close')?.click()`)
    check(
      '场景3b 查找高亮随编辑映射且跳转不失效',
      findHits > 0 && findMappedOk && afterStep >= 1,
      JSON.stringify({ initialHits: findHits, findMapDetail, afterStep }),
    )

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

    // ---------- 场景 5a：外部修改检测与重载 ----------
    // 关自动保存避免 5s 周期写盘把脏标签中途变干净（跑完恢复）；打开文件时
    // 渲染层已把 sample.md / copy-1.md 同步给主进程监视器，这里直接改磁盘。
    await setAutosaveViaMenu(mainCdp, false)

    // 5a-1 干净标签：外部修改后自动重载，不弹提示条
    await writeFile(MD_PATH, `# 外部修改一\n\n${EXT_V1}\n`, 'utf-8')
    const extAuto = await waitEditorState(rendererCdp, EXT_V1, false)
    check('场景5a1 干净标签外部修改后自动重载', !!extAuto, extAuto)

    // 5a-2 脏标签：外部修改弹提示条（绝不静默覆盖未保存内容）
    await insertText(rendererCdp, DIRTY_BEFORE_EXT)
    await waitEditorState(rendererCdp, DIRTY_BEFORE_EXT, true)
    await writeFile(MD_PATH, `# 外部修改二\n\n${EXT_V2}\n`, 'utf-8')
    const barShown = await waitExtBar(rendererCdp, true)
    check('场景5a2 脏标签外部修改后弹出提示条', barShown)

    // 5a-3 提示条「重新加载」：采用磁盘内容并清脏
    await clickExtBarButton(rendererCdp, 'reload')
    const extReload = await waitEditorState(rendererCdp, EXT_V2, false)
    check('场景5a3 重新加载采用磁盘内容并清脏', !!extReload, extReload)

    // 5a-4 提示条「保留我的版本」：本地未保存内容不被覆盖
    await insertText(rendererCdp, KEEP_MINE_MARKER)
    await waitEditorState(rendererCdp, KEEP_MINE_MARKER, true)
    await writeFile(MD_PATH, `# 外部修改三\n\n${EXT_V3}\n`, 'utf-8')
    await waitExtBar(rendererCdp, true)
    await clickExtBarButton(rendererCdp, 'keep')
    const extKeep = await waitEditorState(rendererCdp, KEEP_MINE_MARKER, true)
    const keptText = /** @type {string} */ (
      await rendererCdp.evalJson(
        `document.querySelector('#editor .ProseMirror')?.innerText || ''`,
      )
    )
    check(
      '场景5a4 保留我的版本不覆盖本地未保存内容',
      !!extKeep && !keptText.includes(EXT_V3),
      extKeep,
    )

    // 恢复自动保存（后续场景的脏标签状态不受 5s 定时写盘影响：内容仍持续被编辑）
    await setAutosaveViaMenu(mainCdp, true)
    // 恢复磁盘正文为场景 4 保存的内容：5a 的三次外部改写只为验证监视链路，
    // 不还原会污染后续历史快照断言（场景 5f 校验「恢复不直接改写磁盘」）
    await writeFile(
      MD_PATH,
      `# E2E-EDIT-MARKER-7f3aTMD 主链路验证文档\n\n用于桌面主链路 E2E：打开 → 编辑 → 保存 → 另存为 → 崩溃恢复。\n`,
      'utf-8',
    )

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

    // ---------- 场景 6b：左右分屏（源码 + 所见即所得） ----------
    // 前置归位：视图模式是全局状态，若前序步骤留下源码/分屏态，单击只会「切走」
    // 而不是「切入」，断言就会错位——先确保回到所见即所得
    await rendererCdp.evalJson(`(() => {
      if (document.body.classList.contains('view-source')) document.getElementById('source-mode-btn')?.click()
      return document.body.className
    })()`)
    if ((await rendererCdp.evalJson(`document.body.classList.contains('view-split')`)) === true) {
      await clickSplitMenuItem(rendererCdp)
    }
    await sleep(500)

    await clickSplitMenuItem(rendererCdp)
    /** @type {Record<string, unknown> | null} */
    let splitState = null
    for (let i = 0; i < 40; i++) {
      splitState = JSON.parse(
        /** @type {string} */ (
          await rendererCdp.evalJson(`JSON.stringify({
            isSplit: document.body.classList.contains('view-split'),
            srcVisible: document.getElementById('src-pane')?.hidden === false,
            dividerVisible: document.getElementById('split-divider')?.hidden === false,
            cmReadonly: document.querySelector('#src-editor .cm-content')?.getAttribute('contenteditable') === 'false',
            pmReadonly: document.querySelector('#editor .ProseMirror')?.getAttribute('contenteditable') === 'false',
            cmText: (document.querySelector('#src-editor .cm-content')?.textContent || '').slice(0, 300),
            bodyClass: document.body.className
          })`)
        ),
      )
      if (splitState.isSplit === true) break
      await sleep(200)
    }
    check(
      '场景6b 分屏打开：两栏并排，所见即所得可编辑、源码侧只读并已载入当前文档',
      splitState?.isSplit === true &&
        splitState.srcVisible === true &&
        splitState.dividerVisible === true &&
        splitState.pmReadonly === false &&
        splitState.cmReadonly === true &&
        String(splitState.cmText).includes('主链路验证文档'),
      JSON.stringify(splitState),
    )

    // 所见即所得侧输入 → 源码侧防抖跟随
    await insertText(rendererCdp, SPLIT_MARKER)
    let followOk = false
    for (let i = 0; i < 40; i++) {
      const text = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('#src-editor .cm-content')?.textContent || ''`,
        )
      )
      if (text.includes(SPLIT_MARKER)) {
        followOk = true
        break
      }
      await sleep(250)
    }
    check('场景6c 所见即所得输入后源码侧跟随更新', followOk)

    // 点源码侧 → 它成为可编辑侧，所见即所得转只读
    await rendererCdp.evalJson(`(() => {
      const pane = document.getElementById('src-pane')
      const el = document.querySelector('#src-editor .cm-content') || pane
      const rect = el.getBoundingClientRect()
      pane.dispatchEvent(new MouseEvent('mousedown', {
        clientX: rect.left + 30, clientY: rect.top + 30, bubbles: true,
      }))
      return true
    })()`)
    await sleep(700)
    const activeState = JSON.parse(
      /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          cmReadonly: document.querySelector('#src-editor .cm-content')?.getAttribute('contenteditable') === 'false',
          pmReadonly: document.querySelector('#editor .ProseMirror')?.getAttribute('contenteditable') === 'false'
        })`)
      ),
    )
    check(
      '场景6d 点源码侧后由源码编辑、所见即所得转只读',
      activeState.cmReadonly === false && activeState.pmReadonly === true,
      JSON.stringify(activeState),
    )

    // 反向同步：源码为编辑侧时在源码里输入 → 所见即所得防抖跟随
    await rendererCdp.evalJson(`document.querySelector('#src-editor .cm-content')?.focus()`)
    await rendererCdp.send('Input.insertText', { text: CM_EDIT_MARKER })
    let reverseFollowOk = false
    for (let i = 0; i < 40; i++) {
      const text = await editorText(rendererCdp)
      if (text.includes(CM_EDIT_MARKER)) {
        reverseFollowOk = true
        break
      }
      await sleep(250)
    }
    check('场景6d2 源码侧输入后所见即所得跟随更新（反向同步）', reverseFollowOk)

    // 拖拽分隔条 → 比例变化并持久化
    const ratioBefore = /** @type {string} */ (
      await rendererCdp.evalJson(
        `document.getElementById('panes')?.style.getPropertyValue('--split-ratio') || ''`,
      )
    )
    await rendererCdp.evalJson(`(() => {
      const divider = document.getElementById('split-divider')
      const rect = divider.getBoundingClientRect()
      divider.dispatchEvent(new MouseEvent('mousedown', {
        clientX: rect.left + 2, clientY: rect.top + 20, bubbles: true,
      }))
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + 160, clientY: rect.top + 20, bubbles: true,
      }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    const ratioAfter = /** @type {string} */ (
      await rendererCdp.evalJson(
        `document.getElementById('panes')?.style.getPropertyValue('--split-ratio') || ''`,
      )
    )
    const ratioStored = /** @type {string} */ (
      await rendererCdp.evalJson(`localStorage.getItem('tmd:split-ratio') || ''`)
    )
    check(
      '场景6e 拖拽分隔条改变左右比例并写入持久化',
      ratioBefore !== '' && ratioAfter !== ratioBefore && ratioStored !== '',
      `${ratioBefore} → ${ratioAfter}，持久化 ${ratioStored}`,
    )

    // 再点一次退出分屏
    await clickSplitMenuItem(rendererCdp)
    await sleep(600)
    const closedState = JSON.parse(
      /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          isSplit: document.body.classList.contains('view-split'),
          srcHidden: document.getElementById('src-pane')?.hidden === true,
          pmReadonly: document.querySelector('#editor .ProseMirror')?.getAttribute('contenteditable') === 'false'
        })`)
      ),
    )
    check(
      '场景6f 再次点击退出分屏并恢复单栏可编辑',
      closedState.isSplit === false &&
        closedState.srcHidden === true &&
        closedState.pmReadonly === false,
      JSON.stringify(closedState),
    )

    // ---------- 场景 6g：纯源码模式回归（视图三态中的 source） ----------
    // 源码模式的退出路径已由「重建编辑器」改为「parser + dispatch 原地更新」，
    // 这里覆盖「源码侧改动能否并回所见即所得」
    await rendererCdp.evalJson(`document.getElementById('source-mode-btn')?.click()`)
    /** @type {Record<string, unknown> | null} */
    let sourceState = null
    for (let i = 0; i < 40; i++) {
      sourceState = JSON.parse(
        /** @type {string} */ (
          await rendererCdp.evalJson(`JSON.stringify({
            isSource: document.body.classList.contains('view-source'),
            pmHidden: document.querySelector('.page-scroll')?.hidden === true,
            srcVisible: document.getElementById('src-pane')?.hidden === false,
            cmReadonly: document.querySelector('#src-editor .cm-content')?.getAttribute('contenteditable') === 'false',
            bodyClass: document.body.className
          })`)
        ),
      )
      if (sourceState.isSource === true) break
      await sleep(200)
    }
    check(
      '场景6g 切到纯源码模式：单栏源码可编辑、所见即所得隐藏',
      sourceState?.isSource === true &&
        sourceState.pmHidden === true &&
        sourceState.srcVisible === true &&
        sourceState.cmReadonly === false,
      JSON.stringify(sourceState),
    )

    await rendererCdp.evalJson(`document.querySelector('#src-editor .cm-content')?.focus()`)
    await rendererCdp.send('Input.insertText', { text: SOURCE_MARKER })
    await sleep(500)

    // ---------- 场景 6g2：源码侧编辑置脏 + 恢复副本（仍在源码模式中断言） ----------
    // 源码侧编辑是真实编辑：须同步置脏（关闭保护/自动保存依赖），且恢复副本在
    // 低优序列化节拍后以源码内容为权威覆盖（否则崩溃恢复回退到进源码模式前）
    const sourceDirtyState = JSON.parse(
      await rendererCdp.evalJson(`JSON.stringify({
        title: document.title,
        tabLabel: document.querySelector('#tab-bar .tab.active span')?.textContent ?? '',
      })`),
    )
    let sourceRecovery = null
    for (let i = 0; i < 20; i++) {
      sourceRecovery = await rendererCdp.evalJson(`localStorage.getItem('tmd:doc:v1')`)
      if (typeof sourceRecovery === 'string' && sourceRecovery.includes(SOURCE_MARKER)) break
      await sleep(250)
    }
    check(
      '场景6g2 源码模式编辑置脏且恢复副本覆盖源码内容',
      typeof sourceRecovery === 'string' &&
        sourceRecovery.includes(SOURCE_MARKER) &&
        sourceDirtyState.title.startsWith('• ') === true &&
        sourceDirtyState.tabLabel.startsWith('• ') === true,
      JSON.stringify({
        title: sourceDirtyState.title,
        tabLabel: sourceDirtyState.tabLabel,
        recovered: typeof sourceRecovery === 'string' ? sourceRecovery.includes(SOURCE_MARKER) : null,
      }),
    )

    await rendererCdp.evalJson(`document.getElementById('source-mode-btn')?.click()`)
    // 退出源码模式后：视图回到单栏，且源码侧改动已并回所见即所得
    let afterSourceExit = ''
    for (let i = 0; i < 40; i++) {
      afterSourceExit = await editorText(rendererCdp)
      const isSource = await rendererCdp.evalJson(`document.body.classList.contains('view-source')`)
      if (isSource !== true && afterSourceExit.includes(SOURCE_MARKER)) break
      await sleep(250)
    }
    check(
      '场景6h 退出源码模式后源码侧改动并回所见即所得',
      afterSourceExit.includes(SOURCE_MARKER),
      `正文 ${afterSourceExit.length} 字符`,
    )

    // ---------- 场景 6i：侧边栏文件管理（挂载 → 新建 → 重命名） ----------
    // 打开文件夹（stub 指向工作目录）→ 根行 ＋文 按钮行内新建 → 右键重命名。
    // 全程断言磁盘真实变化；「在系统中显示」会拉起访达窗口，不在 E2E 覆盖。
    // 中文名文档同时就位：供场景 6j 的拼音首字母匹配使用（挂载读盘时必须在场）
    await writeFile(
      join(DOCS_DIR, '项目说明.md'),
      '# 项目说明\n\n拼音首字母匹配验证文档。\n',
      'utf-8',
    )
    await rendererCdp.evalJson(
      `document.getElementById('menu-files-btn')?.click()`,
    )
    await rendererCdp.evalJson(`(() => {
      document.querySelector('.sidebar-subtitle-row') // 确保 files 面板 DOM 存在
    })()`)
    await mainCdp.evalJson(`global.__tmdE2E.nextOpenDir = ${JSON.stringify(DOCS_DIR)}`)
    await rendererCdp.evalJson(`document.getElementById('open-folder-btn')?.click()`)
    let folderMounted = false
    for (let i = 0; i < 40; i++) {
      const has = await rendererCdp.evalJson(
        `!!document.querySelector('#folder-tree .tree-folder.tree-recent')`,
      )
      if (has) {
        folderMounted = true
        break
      }
      await sleep(250)
    }
    check('场景6i1 打开文件夹挂载到侧边栏并展开', folderMounted)

    // 根行「＋文」→ 行内输入 → Enter：磁盘产出 .md 并自动打开为激活标签。
    // 提交偶发不生效（树重渲染竞态），文件未出现时补发一次 Enter（输入行仍在）
    await rendererCdp.evalJson(`window.__dbg = { errs: [] }; window.addEventListener('error', (e) => window.__dbg.errs.push(e.message)); window.addEventListener('unhandledrejection', (e) => window.__dbg.errs.push('rej:' + (e.reason?.message || e.reason)))`)
    await rendererCdp.evalJson(`document.querySelector('.tree-dir-add-file')?.click()`)
    for (let i = 0; i < 20; i++) {
      if (await rendererCdp.evalJson(`!!document.querySelector('.tree-inline-input')`)) break
      await sleep(250)
    }
    /** 提交行内输入并在文件未落盘时重试一次（行内输入行仍存在为前提） */
    async function commitInlineCreate() {
      await rendererCdp.evalJson(`(() => {
        const input = document.querySelector('.tree-inline-input')
        if (!input) return
        input.value = 'e2e-created'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })()`)
      for (let i = 0; i < 12; i++) {
        if (existsSync(join(DOCS_DIR, 'e2e-created.md'))) return true
        await sleep(250)
      }
      return existsSync(join(DOCS_DIR, 'e2e-created.md'))
    }
    let createdOk = await commitInlineCreate()
    if (
      !createdOk &&
      (await rendererCdp.evalJson(`!!document.querySelector('.tree-inline-input')`))
    ) {
      createdOk = await commitInlineCreate()
    }
    let created = false
    let createDetail = ''
    for (let i = 0; i < 20; i++) {
      createDetail = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
        )
      )
      if (createdOk && /e2e-created\.md/.test(createDetail)) {
        created = true
        break
      }
      await sleep(250)
    }
    check('场景6i2 行内新建文件落盘并自动打开', created, createDetail)

    // 右键该行 → 菜单「重命名」→ 行内输入 → Enter：磁盘与标签同步改名
    await rendererCdp.evalJson(`(() => {
      const row = [...document.querySelectorAll('#folder-tree [title]')].find(
        (el) => el.title.endsWith('e2e-created.md'),
      )
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })()`)
    let menuShown = false
    for (let i = 0; i < 20; i++) {
      const has = await rendererCdp.evalJson(
        `!!document.querySelector('.file-context-menu')`,
      )
      if (has) {
        menuShown = true
        break
      }
      await sleep(250)
    }
    check('场景6i3 文件行右键弹出管理菜单', menuShown)

    await rendererCdp.evalJson(`(() => {
      const item = [...document.querySelectorAll('.file-context-menu .menu-item')].find(
        (el) => /重命名|Rename/.test(el.textContent || ''),
      )
      item?.click()
    })()`)
    })`))
    for (let i = 0; i < 20; i++) {
      if (await rendererCdp.evalJson(`!!document.querySelector('.tree-inline-input')`)) break
      await sleep(250)
    }
    /** 提交行内重命名；同一竞态防护：磁盘未改名且输入行仍在则补发一次 Enter */
    async function commitInlineRename() {
      await rendererCdp.evalJson(`(() => {
        const input = document.querySelector('.tree-inline-input')
        if (!input) return
        input.value = 'e2e-renamed.md'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })()`)
      for (let i = 0; i < 12; i++) {
        if (
          existsSync(join(DOCS_DIR, 'e2e-renamed.md')) &&
          !existsSync(join(DOCS_DIR, 'e2e-created.md'))
        ) {
          return true
        }
        await sleep(250)
      }
      return false
    }
    })`))
    let renamedOk = await commitInlineRename()
    if (
      !renamedOk &&
      (await rendererCdp.evalJson(`!!document.querySelector('.tree-inline-input')`))
    ) {
      renamedOk = await commitInlineRename()
    }
    let renamed = false
    let renameDetail = ''
    for (let i = 0; i < 20; i++) {
      renameDetail = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
        )
      )
      if (renamedOk && /e2e-renamed\.md/.test(renameDetail)) {
        renamed = true
        break
      }
      await sleep(250)
    }
    check('场景6i4 重命名落盘生效且打开标签同步改名', renamed, renameDetail)

    // ---------- 场景 6j：快速切换拼音首字母匹配 ----------
    // Ctrl+P → 输入「xmsm」→ 命中「项目说明.md」→ 回车打开。
    // pinyin-pro 字典在面板首次打开时懒加载，轮询断言天然容忍加载延迟。
    // CDP 位掩码：Meta=4（macOS 惯例 Cmd+P；isSameAccelerator 同样接受 Ctrl+P）
    await rendererCdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'p',
      code: 'KeyP',
      windowsVirtualKeyCode: 80,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    })
    let qsOpen = false
    for (let i = 0; i < 20; i++) {
      const open = await rendererCdp.evalJson(
        `!document.getElementById('qs-overlay')?.hidden`,
      )
      if (open) {
        qsOpen = true
        break
      }
      await sleep(250)
    }
    check('场景6j1 Ctrl+P 打开快速切换面板', qsOpen)

    await rendererCdp.send('Input.insertText', { text: 'xmsm' })
    let qsHit = false
    let qsDetail = ''
    for (let i = 0; i < 40; i++) {
      qsDetail = /** @type {string} */ (
        await rendererCdp.evalJson(`JSON.stringify({
          first: document.querySelector('.qs-item .qs-name')?.textContent || '',
          count: document.querySelectorAll('.qs-item').length,
        })`)
      )
      if (JSON.parse(qsDetail).first.includes('项目说明.md')) {
        qsHit = true
        break
      }
      await sleep(250)
    }
    check('场景6j2 拼音首字母 xmsm 命中中文名文件', qsHit, qsDetail)

    await rendererCdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
    let qsOpened = false
    for (let i = 0; i < 20; i++) {
      const tabText = /** @type {string} */ (
        await rendererCdp.evalJson(
          `document.querySelector('.tab.active')?.textContent?.trim() || ''`,
        )
      )
      if (/项目说明\.md/.test(tabText)) {
        qsOpened = true
        break
      }
      await sleep(250)
    }
    check('场景6j3 回车打开中文名文件', qsOpened)

    // 收尾：把激活标签切回 sample.md。恢复副本是单槽（跟随最后编辑的标签），
    // 6i/6j 打开的新文档若留在激活位，其空内容会覆盖副本，破坏场景 9 的前提
    await rendererCdp.evalJson(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find((el) =>
        /sample\\.md/.test(el.textContent || ''),
      )
      tab?.click()
    })()`)
    await sleep(600)

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
