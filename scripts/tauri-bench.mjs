/**
 * Tauri 版大文档性能基准（Windows / WebView2 CDP）。
 *
 * 与 scripts/desktop-bench.mjs（Electron 版）同构：同一组文档生成器、同一组
 * 渲染层探针、同一套指标口径，两版数字可直接同机对照。差异只在壳层驱动：
 *  - 启动：WebView2 经环境变量开调试端口；计时点为 进程 spawn → 调试端口就绪
 *    → 页面目标出现 → 编辑器挂载
 *  - 打开：Windows 首启不处理 argv（仅 macOS Opened 事件），故走「二次实例
 *    argv 转交」的真实打开链路（单实例插件 → queue_open_path → tmd-open-path →
 *    openPath），与资源管理器双击 .md 文件同路径
 *  - 内存：tmd.exe（按可执行路径匹配）+ 其拉起的 msedgewebview2 子进程
 *    （按命令行中的隔离 userData 目录匹配）WorkingSet 求和
 *
 * 四类计时指标 + 一项渲染契约断言（口径与 Electron 版一致）：
 *  - 打开耗时：发起打开到编辑器内容就绪的墙钟时间（含 readFile、解析、全量 DOM 构建、首屏）
 *  - 输入延迟：input 事件到 setTimeout(0) 的同步成本 与 到下一帧的可感知延迟（中位/最大）
 *  - 滚动 FPS：程序化连续滚动 2 秒内的 rAF 帧率与最长帧间隔
 *  - 长任务：PerformanceObserver 记录的 longtask 数量/总时长/最长
 *  - 懒渲染覆盖：帧率采样后按视口逐屏滚完全篇，断言每张图表都被按需补渲
 *
 * 用法：
 *   node scripts/tauri-bench.mjs            # 报告
 *   node scripts/tauri-bench.mjs --json     # 报告 + 末行 BENCH_JSON
 *   node scripts/tauri-bench.mjs --exe <path>
 *
 * 前置：npm run dist:tauri:win:dir 先出 exe；正在运行的 TMD 实例会被结束
 * （单实例锁会吞掉二次实例转交）。仅支持 Windows（WebView2 CDP）。
 *
 * @author chiangyang
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.TMD_BENCH_CDP_PORT ?? 9226)
const USE_DEBUG = process.argv.includes('--debug')
const exeArgIdx = process.argv.indexOf('--exe')
const PROFILE = USE_DEBUG ? 'debug' : 'release'
const EXE =
  exeArgIdx > 0 && process.argv[exeArgIdx + 1]
    ? process.argv[exeArgIdx + 1]
    : join(REPO, 'src-tauri', 'target', PROFILE, 'tmd.exe')
const JSON_OUT = process.argv.includes('--json')
const NO_ASSERT = process.argv.includes('--no-assert')

if (process.platform !== 'win32') {
  console.error('[tauri-bench] 仅支持 Windows（WebView2 CDP）；macOS 请走人工清单')
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error(`[tauri-bench] 找不到 ${EXE}\n先跑：npm run dist:tauri:win:dir`)
  process.exit(2)
}

// ---------- 与 desktop-bench.mjs 相同的文档生成器与统计口径 ----------

/** 中位数（偶数个取中间两值均值） */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 生成约 targetBytes 的纯文本 Markdown（段落间空行，避免被解析成单段） */
function buildBigText(targetBytes) {
  const para =
    'TMD 大文档性能基准：本段用于制造足够长的文档内容，验证编辑器在 MB 级文本下的打开、输入与滚动表现。'
  const parts = ['# 大文档性能基准（纯文本）\n\n']
  let size = Buffer.byteLength(parts[0], 'utf-8')
  let i = 0
  while (size < targetBytes) {
    const block = `${++i}. ${para}\n\n`
    parts.push(block)
    size += Buffer.byteLength(block, 'utf-8')
  }
  return { markdown: parts.join(''), bytes: size, blocks: i }
}

/** 生成含 chartCount 个 Mermaid 图的 Markdown（模拟"数十图表"的重渲染场景） */
function buildChartDoc(chartCount) {
  const parts = ['# 大文档性能基准（多图表）\n\n']
  let bytes = Buffer.byteLength(parts[0], 'utf-8')
  for (let i = 1; i <= chartCount; i++) {
    const block =
      `## 第 ${i} 节\n\n` +
      `本节说明文本，用于拉开图表间距，模拟真实的图文混排文档。\n\n` +
      '```mermaid\nflowchart TD\n' +
      `  A[输入 ${i}] --> B[处理]\n` +
      '  B --> C{判断}\n  C -->|是| D[完成]\n  C -->|否| E[重试]\n```\n\n' +
      `图表后的补充说明文本。\n\n`
    parts.push(block)
    bytes += Buffer.byteLength(block, 'utf-8')
  }
  return { markdown: parts.join(''), bytes, charts: chartCount }
}

/** 生成「大文本 + 多图表」混排文档（图表按段落数均匀铺开） */
function buildMixedDoc(textBytes, chartCount) {
  const para = '图文混排基准段落：用于在图表之间制造足量正文，模拟真实的文档结构。'
  const unitBytes = Buffer.byteLength(`1. ${para}\n\n`, 'utf-8')
  const paraCount = Math.max(chartCount, Math.floor(textBytes / unitBytes))
  const gap = Math.max(1, Math.floor(paraCount / chartCount))
  const parts = ['# 大文档性能基准（图文混合）\n\n']
  let bytes = Buffer.byteLength(parts[0], 'utf-8')
  let chart = 0
  for (let i = 1; i <= paraCount; i++) {
    const block = `${i}. ${para}\n\n`
    parts.push(block)
    bytes += Buffer.byteLength(block, 'utf-8')
    if (i % gap === 0 && chart < chartCount) {
      chart++
      const diagram =
        '```mermaid\nflowchart LR\n' +
        `  A${chart}[起点] --> B{分支}\n  B -->|是| C[结果]\n  B -->|否| D[回退]\n` +
        '```\n\n'
      parts.push(diagram)
      bytes += Buffer.byteLength(diagram, 'utf-8')
    }
  }
  return { markdown: parts.join(''), bytes, charts: chart, blocks: paraCount }
}

/** 纯文本文档目标体积 */
const BIG_TEXT_BYTES = 1024 * 1024
/** 多图表文档的 Mermaid 数量 */
const CHART_COUNT = 30
/** 图文混排文档的正文体积与图表数量 */
const MIXED_TEXT_BYTES = 400 * 1024
const MIXED_CHARTS = 30

/**
 * 回归门禁阈值：与 desktop-bench.mjs 同源（含 Windows 平台系数）。
 */
const PLATFORM_FACTOR = process.platform === 'win32' ? 1.5 : 1
const LIMITS = {
  maxOpenMs: 3000 * PLATFORM_FACTOR,
  minFps: 45,
  maxInputSyncMs: 80 * PLATFORM_FACTOR,
  lazyCheckMinCharts: 20,
}

// ---------- CDP 最小客户端（与 tauri-gui-check.mjs 同构） ----------

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

async function evalJson(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常: ${result.exceptionDetails.text}`)
  }
  return result.result?.value
}

// ---------- 进程与启动 ----------

/** 列出正在运行的 tmd.exe 进程 id（单实例锁会把新进程转交给它） */
function runningInstances() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process tmd -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
      ],
      { encoding: 'utf8' },
    )
    return out
      .split(/\s+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function killStaleInstances() {
  const stale = runningInstances()
  if (!stale.length) return
  console.log(`[tauri-bench] 结束正在运行的 TMD 实例 PID ${stale.join(', ')}（单实例锁冲突）`)
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    'Get-Process tmd -ErrorAction SilentlyContinue | Stop-Process -Force',
  ])
}

/**
 * 调试端口/页面/编辑器三段计时。
 * 轮询间隔 25ms：启动计时要求比 smoke 脚本（250ms）更细的粒度。
 */
async function waitStartup(child) {
  const t0 = Date.now()
  const mark = { portMs: 0, pageMs: 0, mountMs: 0 }
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const deadline = Date.now() + 45000
  let page = null
  while (Date.now() < deadline) {
    if (exited) throw new Error('应用进程已退出（单实例锁冲突？）')
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      if (!mark.portMs) mark.portMs = Date.now() - t0
      const hit = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (hit) {
        page = hit
        mark.pageMs = Date.now() - t0
        break
      }
    } catch {
      /* 端口未就绪 */
    }
    await sleep(25)
  }
  if (!page) throw new Error(`等待 CDP 端口 ${PORT} 超时`)

  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  while (Date.now() < deadline) {
    if (exited) throw new Error('应用进程已退出')
    const mounted = await evalJson(
      cdp,
      `!!document.querySelector('#editor .ProseMirror') && !!document.querySelector('#word-count')`,
    )
    if (mounted === true) {
      mark.mountMs = Date.now() - t0
      break
    }
    await sleep(25)
  }
  if (!mark.mountMs) throw new Error('编辑器挂载等待超时')
  return { cdp, mark }
}

/** 注入与 Electron 版相同的探针：长任务观察 + 输入延迟打点 */
async function injectProbes(cdp) {
  await evalJson(cdp, `(() => {
    window.__bench = { longTasks: [], inputSync: [], inputFrame: [], frames: [] }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__bench.longTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask', buffered: true })
    } catch { /* 内核不支持 longtask 时该项留空 */ }
    document.addEventListener('input', () => {
      const t0 = performance.now()
      setTimeout(
        () => window.__bench.inputSync.push(Number((performance.now() - t0).toFixed(2))),
        0,
      )
      requestAnimationFrame(() =>
        window.__bench.inputFrame.push(Number((performance.now() - t0).toFixed(2))),
      )
    }, { capture: true })
    return true
  })()`)
}

/**
 * 经二次实例 argv 转交打开文档并计时（真实文件关联路径）。
 * 转交方进程拿到锁后很快自行退出，这里不等它。
 */
async function openAndTime(cdp, filePath, marker, minChars) {
  await evalJson(cdp, `window.__bench.longTasks = []`)
  const t0 = Date.now()
  // 转交方进程拿到锁后很快自行退出，不等它（单实例转交在插件 init 早期完成）
  spawn(EXE, [filePath], {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(WORK, 'udata') },
    stdio: 'ignore',
  })
  let chars = 0
  let settled = false
  for (let i = 0; i < 600; i++) {
    const state = JSON.parse(
      /** @type {string} */ (
        await evalJson(cdp, `(() => {
          const text = document.querySelector('#editor .ProseMirror')?.textContent || ''
          return JSON.stringify({ chars: text.length, marker: text.includes(${JSON.stringify(marker)}) })
        })()`)
      ),
    )
    chars = state.chars
    if (state.marker && chars >= minChars) {
      settled = true
      break
    }
    await sleep(100)
  }
  return { ms: Date.now() - t0, chars, settled }
}

/** 连续插入若干次短文本，返回同步处理与到帧两组延迟样本 */
async function measureInput(cdp, times = 5) {
  await evalJson(cdp, `window.__bench.inputSync = []; window.__bench.inputFrame = []`)
  await evalJson(cdp, `document.querySelector('#editor .ProseMirror')?.focus()`)
  for (let i = 0; i < times; i++) {
    await cdp.send('Input.insertText', { text: ` 基准${i} ` })
    await sleep(120)
  }
  await sleep(400)
  const sync = /** @type {number[]} */ (await evalJson(cdp, `window.__bench.inputSync`))
  const frame = /** @type {number[]} */ (await evalJson(cdp, `window.__bench.inputFrame`))
  return { sync: sync ?? [], frame: frame ?? [] }
}

/** 等图表渲染完成（视口懒渲染下视口外不渲染：数量 1.2 秒不增长也视为完成） */
async function waitCharts(cdp, expected, startedAt = Date.now(), timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let count = 0
  let lastCount = -1
  let stableMs = 0
  while (Date.now() < deadline) {
    count = /** @type {number} */ (
      await evalJson(cdp, `document.querySelectorAll('.mermaid-render svg').length`)
    )
    if (count >= expected) break
    if (count === lastCount) {
      stableMs += 100
      if (stableMs >= 1200) break
    } else {
      stableMs = 0
      lastCount = count
    }
    await sleep(100)
  }
  return { ms: Date.now() - startedAt, count }
}

/** 程序化滚动 2 秒并统计帧率（滚动容器为 .page-scroll） */
async function measureScroll(cdp, ms = 2000) {
  await evalJson(cdp, `(() => {
    const scroller = document.querySelector('.page-scroll')
    window.__bench.frames = []
    if (!scroller) return false
    const t0 = performance.now()
    let pos = scroller.scrollTop
    const tick = () => {
      window.__bench.frames.push(performance.now())
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const timer = setInterval(() => {
      pos += 240
      scroller.scrollTop = pos
      if (performance.now() - t0 > ${ms}) clearInterval(timer)
    }, 16)
    return true
  })()`)
  await sleep(ms + 600)
  const frames = /** @type {number[]} */ (await evalJson(cdp, `window.__bench.frames`))
  const longTasks = /** @type {number[]} */ (await evalJson(cdp, `window.__bench.longTasks`))
  const list = frames ?? []
  if (list.length < 2) return { fps: 0, maxGapMs: 0, frames: list.length }
  const span = list[list.length - 1] - list[0]
  let maxGap = 0
  for (let i = 1; i < list.length; i++) maxGap = Math.max(maxGap, list[i] - list[i - 1])
  return {
    fps: Number(((list.length / span) * 1000).toFixed(1)),
    maxGapMs: Math.round(maxGap),
    frames: list.length,
    longTasks: longTasks ?? [],
  }
}

/** 读取并清空长任务样本 */
async function takeLongTasks(cdp) {
  const tasks = /** @type {number[]} */ (await evalJson(cdp, `window.__bench.longTasks`))
  await evalJson(cdp, `window.__bench.longTasks = []`)
  const list = tasks ?? []
  return {
    count: list.length,
    totalMs: list.reduce((a, b) => a + b, 0),
    maxMs: list.length ? Math.max(...list) : 0,
  }
}

/** 分块滚到底，统计「滚完全篇后共补渲多少张图」（口径同 Electron 版） */
async function sweepToBottom(cdp, expected) {
  const stepPx = await evalJson(cdp, `(() => {
    const s = document.querySelector('.page-scroll')
    return s ? Math.max(200, Math.floor(s.clientHeight * 0.9)) : 0
  })()`)
  if (!stepPx) return { charts: 0, passes: 0 }
  let charts = 0
  let passes = 0
  for (let pass = 1; pass <= 3; pass++) {
    passes = pass
    await evalJson(cdp, `(() => {
      const s = document.querySelector('.page-scroll')
      if (s) s.scrollTop = 0
      return true
    })()`)
    await sleep(150)
    for (let i = 0; i < 800; i++) {
      const atBottom = await evalJson(cdp, `(() => {
        const s = document.querySelector('.page-scroll')
        if (!s) return true
        s.scrollTop += ${stepPx}
        return s.scrollTop + s.clientHeight >= s.scrollHeight - 4
      })()`)
      await sleep(30)
      if (atBottom) break
    }
    charts = (await waitCharts(cdp, expected, Date.now(), 10000)).count
    if (charts >= expected) break
  }
  await takeLongTasks(cdp)
  return { charts, passes }
}

// ---------- 内存采样 ----------

/**
 * tmd.exe（按可执行路径匹配，避免误伤其他 checkout 的实例）+ 本次拉起的
 * msedgewebview2 子进程（按命令行中独有的 userData 目录匹配）WorkingSet 求和。
 */
async function sampleMemory() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$r=[ordered]@{tmdWs=0;tmdN=0;wvWs=0;wvN=0}",
    `Get-CimInstance Win32_Process -Filter "Name='tmd.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replaceAll("'", "''")}' } | ForEach-Object { $r.tmdWs += $_.WorkingSetSize; $r.tmdN++ }`,
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${USER_DATA.replaceAll("'", "''")}*' } | ForEach-Object { $r.wvWs += $_.WorkingSetSize; $r.wvN++ }`,
    '$r | ConvertTo-Json -Compress',
  ].join('; ')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
  const m = JSON.parse(line)
  return {
    tmdMb: Math.round(m.tmdWs / 1048576),
    tmdCount: m.tmdN,
    webviewMb: Math.round(m.wvWs / 1048576),
    webviewCount: m.wvN,
    totalMb: Math.round((m.tmdWs + m.wvWs) / 1048576),
  }
}

// ---------- 主流程 ----------

const WORK = join(tmpdir(), 'tmd-tauri-bench')
const DOCS_DIR = join(WORK, 'docs')
/** 运行级唯一的 userData 目录（内存匹配 + 全新冷启动 profile） */
const USER_DATA = mkdtempSync(join(tmpdir(), 'tmd-tauri-bench-ud-'))

async function main() {
  killStaleInstances()
  rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  mkdirSync(DOCS_DIR, { recursive: true })

  const big = buildBigText(BIG_TEXT_BYTES)
  const charts = buildChartDoc(CHART_COUNT)
  const mixed = buildMixedDoc(MIXED_TEXT_BYTES, MIXED_CHARTS)
  const bigPath = join(DOCS_DIR, 'big-text.md')
  const chartPath = join(DOCS_DIR, 'many-charts.md')
  const mixedPath = join(DOCS_DIR, 'mixed.md')
  await writeFileSync(bigPath, big.markdown, 'utf-8')
  await writeFileSync(chartPath, charts.markdown, 'utf-8')
  await writeFileSync(mixedPath, mixed.markdown, 'utf-8')

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let cdp = null
  const report = []
  const memSamples = {}
  const startup = {}

  try {
    // ---- 冷启动计时 ----
    const t0 = Date.now()
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: USER_DATA,
      },
      stdio: 'ignore',
    })
    const launched = await waitStartup(child)
    cdp = launched.cdp
    Object.assign(startup, launched.mark)
    startup.totalMs = Date.now() - t0
    console.log(
      `\n[启动] 端口 ${startup.portMs} ms → 页面 ${startup.pageMs} ms → 编辑器挂载 ${startup.mountMs} ms`,
    )

    await injectProbes(cdp)
    memSamples.idle = await sampleMemory()

    // ---- 文档 A：MB 级纯文本 ----
    const openA = await openAndTime(
      cdp,
      bigPath,
      '大文档性能基准（纯文本）',
      Math.floor(big.markdown.length * 0.7),
    )
    if (!openA.settled) throw new Error('纯文本大文档打开未就绪')
    const longA = await takeLongTasks(cdp)
    const inputA = await measureInput(cdp)
    const scrollA = await measureScroll(cdp)
    report.push({
      name: '纯文本大文档',
      sizeKb: Math.round(big.bytes / 1024),
      extra: `${big.blocks} 段`,
      openMs: openA.ms,
      chars: openA.chars,
      inputSyncMs: median(inputA.sync),
      inputFrameMs: median(inputA.frame),
      inputMaxFrameMs: inputA.frame.length ? Math.max(...inputA.frame) : 0,
      fps: scrollA.fps,
      maxGapMs: scrollA.maxGapMs,
      longTaskCount: longA.count,
      longTaskTotalMs: longA.totalMs,
      longTaskMaxMs: longA.maxMs,
    })

    // ---- 文档 B：数十 Mermaid 图表 ----
    const openB = await openAndTime(
      cdp,
      chartPath,
      '大文档性能基准（多图表）',
      Math.floor(charts.markdown.length * 0.7),
    )
    if (!openB.settled) throw new Error('多图表文档打开未就绪')
    // 内容就绪时图表仍在排队渲染，此刻的输入延迟最能反映主线程争抢
    const readyAtB = Date.now()
    const inputB = await measureInput(cdp)
    const chartsB = await waitCharts(cdp, charts.charts, readyAtB)
    const chartsTotal = /** @type {number} */ (
      await evalJson(cdp, `document.querySelectorAll('.mermaid-block').length`)
    )
    const longBOpen = await takeLongTasks(cdp)
    const scrollB = await measureScroll(cdp)
    const sweepB = await sweepToBottom(cdp, chartsTotal)
    report.push({
      name: '多图表文档',
      sizeKb: Math.round(charts.bytes / 1024),
      extra: `${charts.charts} 张 Mermaid`,
      openMs: openB.ms,
      chars: openB.chars,
      chartsRendered: chartsB.count,
      chartsTotal,
      chartsAfterScroll: sweepB.charts,
      chartsPasses: sweepB.passes,
      inputSyncMs: median(inputB.sync),
      inputFrameMs: median(inputB.frame),
      inputMaxFrameMs: inputB.frame.length ? Math.max(...inputB.frame) : 0,
      fps: scrollB.fps,
      maxGapMs: scrollB.maxGapMs,
      longTaskCount: longBOpen.count + (scrollB.longTasks?.length ?? 0),
      longTaskTotalMs: longBOpen.totalMs + (scrollB.longTasks ?? []).reduce((a, b) => a + b, 0),
      longTaskMaxMs: Math.max(longBOpen.maxMs, ...(scrollB.longTasks ?? [0])),
      openLongTaskTotalMs: longBOpen.totalMs,
      openLongTaskMaxMs: longBOpen.maxMs,
    })

    // ---- 文档 C：大文本 + 多图表混排（真实重文档） ----
    const openC = await openAndTime(
      cdp,
      mixedPath,
      '大文档性能基准（图文混合）',
      Math.floor(mixed.markdown.length * 0.7),
    )
    if (!openC.settled) throw new Error('图文混合文档打开未就绪')
    const readyAtC = Date.now()
    const inputC = await measureInput(cdp)
    const chartsC = await waitCharts(cdp, mixed.charts, readyAtC)
    const longCOpen = await takeLongTasks(cdp)
    const scrollC = await measureScroll(cdp)
    const chartsTotalC = /** @type {number} */ (
      await evalJson(cdp, `document.querySelectorAll('.mermaid-block').length`)
    )
    const sweepC = await sweepToBottom(cdp, chartsTotalC)
    report.push({
      name: '图文混合大文档',
      sizeKb: Math.round(mixed.bytes / 1024),
      extra: `${mixed.blocks} 段 + ${mixed.charts} 张 Mermaid`,
      openMs: openC.ms,
      chars: openC.chars,
      chartsRendered: chartsC.count,
      chartsTotal: chartsTotalC,
      chartsAfterScroll: sweepC.charts,
      chartsPasses: sweepC.passes,
      inputSyncMs: median(inputC.sync),
      inputFrameMs: median(inputC.frame),
      inputMaxFrameMs: inputC.frame.length ? Math.max(...inputC.frame) : 0,
      fps: scrollC.fps,
      maxGapMs: scrollC.maxGapMs,
      longTaskCount: longCOpen.count + (scrollC.longTasks?.length ?? 0),
      longTaskTotalMs: longCOpen.totalMs + (scrollC.longTasks ?? []).reduce((a, b) => a + b, 0),
      longTaskMaxMs: Math.max(longCOpen.maxMs, ...(scrollC.longTasks ?? [0])),
      openLongTaskTotalMs: longCOpen.totalMs,
      openLongTaskMaxMs: longCOpen.maxMs,
    })

    // 重文档在场时的驻留内存（三文档标签都开着，最贴近重度使用）
    memSamples.heavy = await sampleMemory()

    console.log('\n===== Tauri 大文档性能基准 =====')
    console.log(
      `\n冷启动：端口 ${startup.portMs} ms / 页面 ${startup.pageMs} ms / 编辑器挂载 ${startup.mountMs} ms（全新 profile）`,
    )
    for (const r of report) {
      console.log(`\n${r.name}（${r.sizeKb} KB，${r.extra}）`)
      console.log(`  打开耗时          ${r.openMs} ms（就绪 ${r.chars} 字符）`)
      if (r.chartsRendered !== undefined) {
        console.log(
          `  图表渲染          未滚动 ${r.chartsRendered}/${r.chartsTotal} 张，滚完全篇 ${r.chartsAfterScroll}/${r.chartsTotal} 张` +
            `${r.chartsPasses > 1 ? `（第 ${r.chartsPasses} 轮才渲齐）` : ''}`,
        )
      }
      console.log(
        `  输入延迟          同步 ${r.inputSyncMs} ms / 到帧 ${r.inputFrameMs} ms（最大 ${r.inputMaxFrameMs} ms）`,
      )
      console.log(`  滚动              ${r.fps} FPS，最长帧间隔 ${r.maxGapMs} ms`)
      console.log(
        `  长任务            ${r.longTaskCount} 个，合计 ${r.longTaskTotalMs} ms，最长 ${r.longTaskMaxMs} ms`,
      )
    }
    console.log(
      `\n[内存] 空编辑器 ${memSamples.idle.totalMb} MB（tmd ${memSamples.idle.tmdMb} + webview ${memSamples.idle.webviewMb}，${memSamples.idle.tmdCount}+${memSamples.idle.webviewCount} 进程）；` +
        `三文档在场 ${memSamples.heavy.totalMb} MB（tmd ${memSamples.heavy.tmdMb} + webview ${memSamples.heavy.webviewMb}）`,
    )

    // 回归门禁：与 Electron 版同阈值同口径
    const failures = []
    for (const r of report) {
      if (r.openMs > LIMITS.maxOpenMs) {
        failures.push(`${r.name}：打开耗时 ${r.openMs}ms 超过 ${LIMITS.maxOpenMs}ms`)
      }
      if (r.fps < LIMITS.minFps) {
        failures.push(`${r.name}：滚动 ${r.fps} FPS 低于 ${LIMITS.minFps}`)
      }
      if (r.inputSyncMs > LIMITS.maxInputSyncMs) {
        failures.push(`${r.name}：输入同步耗时 ${r.inputSyncMs}ms 超过 ${LIMITS.maxInputSyncMs}ms`)
      }
      if ((r.chartsTotal ?? 0) >= LIMITS.lazyCheckMinCharts) {
        if (!((r.chartsRendered ?? 0) < r.chartsTotal)) {
          failures.push(
            `${r.name}：视口懒渲染未生效（未滚动即渲染 ${r.chartsRendered}/${r.chartsTotal} 张）`,
          )
        }
        if (!((r.chartsAfterScroll ?? 0) >= r.chartsTotal)) {
          failures.push(`${r.name}：滚完全篇仍有图表未渲（${r.chartsAfterScroll}/${r.chartsTotal}）`)
        }
      }
    }
    if (NO_ASSERT) {
      console.log('\n（--no-assert：跳过回归门禁）')
    } else if (failures.length > 0) {
      console.log('\n===== 回归门禁未通过 =====')
      for (const f of failures) console.log(`  FAIL  ${f}`)
    } else {
      console.log('\n===== 回归门禁通过 =====')
    }
    if (JSON_OUT) {
      console.log(
        '\nBENCH_JSON ' +
          JSON.stringify({ startup, memory: memSamples, docs: report, failures }),
      )
    }
    if (!NO_ASSERT && failures.length > 0) process.exitCode = 1
  } catch (err) {
    console.error('\n基准脚本异常：', err)
    process.exitCode = 2
  } finally {
    if (child) {
      try {
        child.kill()
      } catch {
        /* noop */
      }
    }
    // 只清本次拉起的进程：tmd.exe 按可执行路径、webview2 子进程按 userData 归属
    const cleanup = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `Get-CimInstance Win32_Process -Filter "Name='tmd.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${USER_DATA.replaceAll("'", "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ].join('; ')
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', cleanup], { stdio: 'ignore' })
    } catch {
      /* 清理失败不掩盖基准结果 */
    }
    cdp?.close()
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main()
