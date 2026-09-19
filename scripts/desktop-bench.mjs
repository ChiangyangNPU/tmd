/**
 * 大文档性能基准（MB 级纯文本 / 数十 Mermaid 图表），用于量化「大文档性能兜底」的
 * 优化前后差异，并作为防回归基线。
 *
 * 四类指标（均在真实 dist 产物 + 真实编辑器链路上测得）：
 *  - 打开耗时：菜单「打开」到编辑器内容就绪的墙钟时间（含解析、全量 DOM 构建、首屏）
 *  - 输入延迟：beforeinput 到下一帧的耗时（同步阻塞全部计入，取中位与最大）
 *  - 滚动 FPS：程序化连续滚动 2 秒内的 rAF 帧率与最长帧间隔
 *  - 长任务：PerformanceObserver 记录的 longtask 数量/总时长/最长（决定"打开后多久能操作"）
 *
 * 与 desktop-app-check / desktop-export-check 共享 scripts/lib/desktop-harness.mjs。
 * 本脚本只测不判：输出人类可读报告；带 --json 时额外在末行输出机器可读结果便于前后对比。
 *
 * 用法：
 *   node scripts/desktop-bench.mjs           # 报告
 *   node scripts/desktop-bench.mjs --json    # 报告 + 末行 BENCH_JSON
 *
 * @author chiangyang
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Cdp,
  cleanupElectron,
  killTree,
  sleep,
  spawnApp,
  waitForPortsFree,
  waitForTarget,
} from './lib/desktop-harness.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const WORK = join(tmpdir(), 'tmd-bench')
const PROFILE = join(WORK, 'profile')
const HOME_DIR = join(WORK, 'home')
const DOCS_DIR = join(WORK, 'docs')

/**
 * 清理临时工作目录。刚 killTree 的 Electron 在 Windows 上可能仍短暂占用
 * profile 内的文件句柄（EBUSY），带重试的 rm 等锁释放；重试耗尽后降级为
 * 警告——临时目录残留不应让清理问题掩盖基准结果本身。
 */
async function removeWorkDir() {
  await rm(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    (err) => console.warn(`警告：临时目录清理未完成（${err.code ?? err}），可手动删除 ${WORK}`),
  )
}
/** 纯文本文档目标体积 */
const BIG_TEXT_BYTES = 1024 * 1024
/** 多图表文档的 Mermaid 数量 */
const CHART_COUNT = 30
/** 图文混排文档的正文体积与图表数量 */
const MIXED_TEXT_BYTES = 400 * 1024
const MIXED_CHARTS = 30
const JSON_OUT = process.argv.includes('--json')
const NO_ASSERT = process.argv.includes('--no-assert')

/**
 * 回归门禁阈值：取实测值的宽松上界，只拦「明显退化」而不追求精确比对
 * （同机不同负载下数值本就有波动）。
 *
 * 阈值在开发机上标定（macOS）；不同平台的单核性能差异直接改变绝对耗时
 * （Windows 实测纯文本输入同步约 77ms vs mac 约 40ms），故时间类门限乘以
 * 平台系数——门禁的目的是拦同机上的代码退化，不是跨平台比性能。
 */
const PLATFORM_FACTOR = process.platform === 'win32' ? 1.5 : 1

const LIMITS = {
  /** MB 级文档打开到内容就绪 */
  maxOpenMs: 3000 * PLATFORM_FACTOR,
  /** 滚动帧率下限（帧率类门限不受平台系数影响，45fps 是交互底线） */
  minFps: 45,
  /** 单次输入的同步处理耗时上限 */
  maxInputSyncMs: 60 * PLATFORM_FACTOR,
  /** 至少这么多张图时才校验懒渲染契约 */
  lazyCheckMinCharts: 20,
}

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

/**
 * 生成「大文本 + 多图表」混排文档（最贴近真实重文档）：图表按段落数均匀铺开，
 * 打开时全部图表都会进入渲染队列——用它检验图表渲染是否与正文编辑争抢主线程。
 */
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

/** 展开调试端口后启动应用并接通两侧 CDP，注入「下一个打开路径」对话框 stub */
async function launch() {
  await waitForPortsFree()
  const child = spawnApp({ repo: REPO, profile: PROFILE, env: { TMD_HOME_DIR: HOME_DIR } })
  const nodeTarget = await waitForTarget(
    9229,
    (t) => t.type === 'node' || t.url?.startsWith('file:') || !!t.webSocketDebuggerUrl,
  )
  const main = new Cdp(nodeTarget.webSocketDebuggerUrl)
  await main.connect()
  await main.send('Runtime.enable')
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { dialog } = req('electron')
    // 「下一个打开路径」由脚本在每次打开前写入；未设置时视为用户取消
    global.__benchNext = null
    dialog.showOpenDialog = async () => {
      const next = global.__benchNext
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] }
    }
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
    return true
  })()`)

  const page = await waitForTarget(9222, (t) => t.type === 'page' && /index\.html/.test(t.url))
  const renderer = new Cdp(page.webSocketDebuggerUrl)
  await renderer.connect()
  await renderer.send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if (
      (await renderer.evalJson(
        `!!document.querySelector('#editor .ProseMirror') && !!document.querySelector('#word-count')`,
      )) === true
    )
      break
    await sleep(250)
  }
  // 探针：长任务观察 + 输入延迟打点（beforeinput → 下一帧，同步阻塞全额计入）
  await renderer.evalJson(`(() => {
    window.__bench = { longTasks: [], inputSync: [], inputFrame: [], frames: [] }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__bench.longTasks.push(Math.round(e.duration))
      }).observe({ type: 'longtask', buffered: true })
    } catch { /* 内核不支持 longtask 时该项留空 */ }
    // 挂在 document 捕获阶段：打开文档会重建 ProseMirror 元素，
    // 挂在启动时的具体元素上会在第一次打开后失效。
    // 双指标：setTimeout(0) 反映「本次按键的同步处理成本」（ProseMirror 的 DOM 观察
    // 回调、markdownUpdated 的全量序列化、localStorage 写入都在它之前完成）；
    // rAF 反映「到下一帧的可感知延迟」，无阻塞时下限就是一帧（约 16.7ms）。
    // 注意不能挂在 beforeinput 上配 microtask——那时 ProseMirror 尚未处理本次输入，
    // 会把成本测成 0。
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
  return { child, main, renderer }
}

/** 点击「文件 → 打开」（走 stub 对话框，路径取 global.__benchNext） */
async function clickOpen(main) {
  await main.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { Menu } = req('electron')
    const m = Menu.getApplicationMenu()
    const fileMenu = m.items.find((i) => i.submenu && i.submenu.items.some((s) => /打开|Open/.test(s.label || '')))
    fileMenu.submenu.items[0].click()
    return true
  })()`)
}

/**
 * 打开文档并测量到内容就绪的墙钟耗时。
 * 就绪判据必须同时看「特征串命中」——只比字符数会在打开第二个文档时
 * 被上一个文档（更长）的残留内容直接满足。
 * @param {Cdp} main @param {Cdp} renderer @param {string} filePath
 * @param {string} marker @param {number} minChars
 */
async function openAndTime(main, renderer, filePath, marker, minChars) {
  await main.evalJson(`global.__benchNext = ${JSON.stringify(filePath)}`)
  await renderer.evalJson(`window.__bench.longTasks = []`)
  const t0 = Date.now()
  await clickOpen(main)
  let chars = 0
  for (let i = 0; i < 600; i++) {
    const state = JSON.parse(
      /** @type {string} */ (
        await renderer.evalJson(`(() => {
          const text = document.querySelector('#editor .ProseMirror')?.textContent || ''
          return JSON.stringify({ chars: text.length, marker: text.includes(${JSON.stringify(marker)}) })
        })()`)
      ),
    )
    chars = state.chars
    if (state.marker && chars >= minChars) break
    await sleep(100)
  }
  return { ms: Date.now() - t0, chars }
}

/**
 * 连续插入若干次短文本，返回同步处理与到帧两组延迟样本。
 * @param {Cdp} renderer @param {number} times
 * @returns {Promise<{ sync: number[], frame: number[] }>}
 */
async function measureInput(renderer, times = 5) {
  await renderer.evalJson(`window.__bench.inputSync = []; window.__bench.inputFrame = []`)
  await renderer.evalJson(`document.querySelector('#editor .ProseMirror')?.focus()`)
  for (let i = 0; i < times; i++) {
    await renderer.send('Input.insertText', { text: ` 基准${i} ` })
    await sleep(120)
  }
  await sleep(400)
  const sync = /** @type {number[]} */ (await renderer.evalJson(`window.__bench.inputSync`))
  const frame = /** @type {number[]} */ (await renderer.evalJson(`window.__bench.inputFrame`))
  return { sync: sync ?? [], frame: frame ?? [] }
}

/**
 * 等图表渲染完成，返回「自 startedAt 起」的耗时（默认从调用时刻算）。
 * 视口懒渲染下视口外的图表不会渲染，数量会停在视口内张数，
 * 故除「达到 expected」外，连续 1.2 秒不再增长也视为完成。
 * @param {Cdp} renderer @param {number} expected
 * @param {number} [startedAt] @param {number} [timeoutMs]
 */
async function waitCharts(renderer, expected, startedAt = Date.now(), timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let count = 0
  let lastCount = -1
  let stableMs = 0
  while (Date.now() < deadline) {
    count = /** @type {number} */ (
      await renderer.evalJson(`document.querySelectorAll('.mermaid-render svg').length`)
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
async function measureScroll(renderer, ms = 2000) {
  await renderer.evalJson(`(() => {
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
  const frames = /** @type {number[]} */ (await renderer.evalJson(`window.__bench.frames`))
  const longTasks = /** @type {number[]} */ (await renderer.evalJson(`window.__bench.longTasks`))
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
async function takeLongTasks(renderer) {
  const tasks = /** @type {number[]} */ (await renderer.evalJson(`window.__bench.longTasks`))
  await renderer.evalJson(`window.__bench.longTasks = []`)
  const list = tasks ?? []
  return {
    count: list.length,
    totalMs: list.reduce((a, b) => a + b, 0),
    maxMs: list.length ? Math.max(...list) : 0,
  }
}

async function main() {
  if (!existsSync(join(REPO, 'dist', 'index.html'))) {
    console.error('未找到 dist 构建产物，请先执行：npm run build')
    process.exit(2)
  }
  cleanupElectron()
  await waitForPortsFree()
  await removeWorkDir()
  await mkdir(DOCS_DIR, { recursive: true })

  const big = buildBigText(BIG_TEXT_BYTES)
  const charts = buildChartDoc(CHART_COUNT)
  const mixed = buildMixedDoc(MIXED_TEXT_BYTES, MIXED_CHARTS)
  const bigPath = join(DOCS_DIR, 'big-text.md')
  const chartPath = join(DOCS_DIR, 'many-charts.md')
  const mixedPath = join(DOCS_DIR, 'mixed.md')
  await writeFile(bigPath, big.markdown, 'utf-8')
  await writeFile(chartPath, charts.markdown, 'utf-8')
  await writeFile(mixedPath, mixed.markdown, 'utf-8')

  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child = null
  /** @type {Cdp | null} */
  let mainCdp = null
  /** @type {Cdp | null} */
  let rendererCdp = null
  const report = []

  try {
    ;({ child, main: mainCdp, renderer: rendererCdp } = await launch())

    // ---- 文档 A：MB 级纯文本 ----
    // 就绪判据用 markdown 字符数（非字节数：中文 1 字符约 3 字节）打七折，
    // 留出标记符号被剥离的余量
    const openA = await openAndTime(
      mainCdp,
      rendererCdp,
      bigPath,
      '大文档性能基准（纯文本）',
      Math.floor(big.markdown.length * 0.7),
    )
    const longA = await takeLongTasks(rendererCdp)
    const inputA = await measureInput(rendererCdp)
    const scrollA = await measureScroll(rendererCdp)
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
      mainCdp,
      rendererCdp,
      chartPath,
      '大文档性能基准（多图表）',
      Math.floor(charts.markdown.length * 0.7),
    )
    // 内容就绪时图表仍在排队渲染，此刻的输入延迟最能反映「图表争抢主线程」
    // 的真实体验（图表全部渲染完再测就测不到卡顿了）
    const readyAtB = Date.now()
    const inputB = await measureInput(rendererCdp)
    // 等首屏图表全部渲染完成，统计耗时与实际渲染数量
    const chartsB = await waitCharts(rendererCdp, charts.charts, readyAtB)
    const chartsTotal = /** @type {number} */ (
      await rendererCdp.evalJson(`document.querySelectorAll('.mermaid-block').length`)
    )
    const longBOpen = await takeLongTasks(rendererCdp)
    const scrollB = await measureScroll(rendererCdp)
    // 滚动后新增的渲染张数：验证「滚到图表处才渲染」的按需行为
    const chartsAfterScrollB = /** @type {number} */ (
      await rendererCdp.evalJson(`document.querySelectorAll('.mermaid-render svg').length`)
    )
    report.push({
      name: '多图表文档',
      sizeKb: Math.round(charts.bytes / 1024),
      extra: `${charts.charts} 张 Mermaid`,
      openMs: openB.ms,
      chars: openB.chars,
      chartsRendered: chartsB.count,
      chartsTotal,
      chartsAfterScroll: chartsAfterScrollB,
      inputSyncMs: median(inputB.sync),
      inputFrameMs: median(inputB.frame),
      inputMaxFrameMs: inputB.frame.length ? Math.max(...inputB.frame) : 0,
      fps: scrollB.fps,
      maxGapMs: scrollB.maxGapMs,
      longTaskCount: longBOpen.count + (scrollB.longTasks?.length ?? 0),
      longTaskTotalMs: longBOpen.totalMs + (scrollB.longTasks ?? []).reduce((a, b) => a + b, 0),
      longTaskMaxMs: Math.max(longBOpen.maxMs, ...(scrollB.longTasks ?? [0])),
      // 打开阶段单独统计：图表是否无视口懒渲染，看这一项
      openLongTaskTotalMs: longBOpen.totalMs,
      openLongTaskMaxMs: longBOpen.maxMs,
    })

    // ---- 文档 C：大文本 + 多图表混排（真实重文档） ----
    const openC = await openAndTime(
      mainCdp,
      rendererCdp,
      mixedPath,
      '大文档性能基准（图文混合）',
      Math.floor(mixed.markdown.length * 0.7),
    )
    // 与 B 同样在「内容就绪、图表刚开始排队渲染」的时刻测输入
    const readyAtC = Date.now()
    const inputC = await measureInput(rendererCdp)
    const chartsC = await waitCharts(rendererCdp, mixed.charts, readyAtC)
    const longCOpen = await takeLongTasks(rendererCdp)
    const scrollC = await measureScroll(rendererCdp)
    const chartsAfterScrollC = /** @type {number} */ (
      await rendererCdp.evalJson(`document.querySelectorAll('.mermaid-render svg').length`)
    )
    report.push({
      name: '图文混合大文档',
      sizeKb: Math.round(mixed.bytes / 1024),
      extra: `${mixed.blocks} 段 + ${mixed.charts} 张 Mermaid`,
      openMs: openC.ms,
      chars: openC.chars,
      chartsRendered: chartsC.count,
      chartsTotal: mixed.charts,
      chartsAfterScroll: chartsAfterScrollC,
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

    console.log('\n===== 大文档性能基准 =====')
    for (const r of report) {
      console.log(`\n${r.name}（${r.sizeKb} KB，${r.extra}）`)
      console.log(`  打开耗时          ${r.openMs} ms（就绪 ${r.chars} 字符）`)
      if (r.chartsRendered !== undefined) {
        console.log(
          `  图表渲染          未滚动 ${r.chartsRendered}/${r.chartsTotal} 张，滚动后 ${r.chartsAfterScroll}/${r.chartsTotal} 张`,
        )
      }
      console.log(
        `  输入延迟          同步 ${r.inputSyncMs} ms / 到帧 ${r.inputFrameMs} ms（最大 ${r.inputMaxFrameMs} ms）`,
      )
      console.log(`  滚动              ${r.fps} FPS，最长帧间隔 ${r.maxGapMs} ms`)
      console.log(
        `  长任务            ${r.longTaskCount} 个，合计 ${r.longTaskTotalMs} ms，最长 ${r.longTaskMaxMs} ms`,
      )
      if (r.openLongTaskTotalMs !== undefined) {
        console.log(
          `  其中打开阶段      ${r.openLongTaskTotalMs} ms（最长 ${r.openLongTaskMaxMs} ms）`,
        )
      }
    }
    // 回归门禁：只拦明显退化；懒渲染契约（未滚动不渲染视口外图表、
    // 滚动后按需补上）是本项的核心行为，单独校验
    /** @type {string[]} */
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
        if (!((r.chartsAfterScroll ?? 0) > (r.chartsRendered ?? 0))) {
          failures.push(
            `${r.name}：滚动后未按需补渲（${r.chartsRendered} → ${r.chartsAfterScroll}）`,
          )
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
    if (JSON_OUT) console.log('\nBENCH_JSON ' + JSON.stringify(report))
    if (!NO_ASSERT && failures.length > 0) {
      if (child) killTree(child)
      cleanupElectron()
      mainCdp?.close()
      rendererCdp?.close()
      await removeWorkDir()
      process.exit(1)
    }
  } catch (err) {
    console.error('\n基准脚本异常：', err)
    if (child) killTree(child)
    cleanupElectron()
    mainCdp?.close()
    rendererCdp?.close()
    process.exit(2)
  }

  if (child) killTree(child)
  cleanupElectron()
  mainCdp?.close()
  rendererCdp?.close()
  await removeWorkDir()
}

main()
