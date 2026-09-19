/**
 * 一次性剖析脚本：定位大文档输入延迟的热点函数（不入常规流程）。
 * 用法：先 npm run build，然后 node scripts/profile-input.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
const WORK = join(tmpdir(), 'tmd-profile')
const PROFILE = join(WORK, 'profile')
const HOME_DIR = join(WORK, 'home')
const DOCS_DIR = join(WORK, 'docs')

// 生成与 bench 同量级的纯文本大文档（约 1MB / 数千段）
function buildBigText() {
  const paras = []
  let size = 0
  const target = 1024 * 1024
  let i = 0
  while (size < target) {
    const para = `第${i}段：${'这是一段用于性能剖析的中文正文内容，长度约一百五十字符，用来模拟真实文档的段落体积与节点分布。'.repeat(2)}`
    paras.push(para)
    size += para.length
    i++
  }
  return paras.join('\n\n')
}

async function main() {
  await rm(WORK, { recursive: true, force: true }).catch(() => {})
  await mkdir(DOCS_DIR, { recursive: true })
  const docPath = join(DOCS_DIR, 'big.md')
  await writeFile(docPath, buildBigText(), 'utf-8')

  await waitForPortsFree()
  const child = spawnApp({ repo: REPO, profile: PROFILE, env: { TMD_HOME_DIR: HOME_DIR } })
  try {
    await run(child, docPath)
  } finally {
    killTree(child)
    cleanupElectron()
    await sleep(500)
    await rm(WORK, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
  process.exit(0)
}

async function run(child, docPath) {
  const nodeTarget = await waitForTarget(
    9229,
    (t) => t.type === 'node' || t.url?.startsWith('file:') || !!t.webSocketDebuggerUrl,
  )
  const mainCdp = new Cdp(nodeTarget.webSocketDebuggerUrl)
  await mainCdp.connect()

  // 等渲染层
  let renderer = null
  for (let i = 0; i < 60; i++) {
    try {
      const page = await waitForTarget(
        9222,
        (t) => t.type === 'page' && /index\.html/.test(t.url ?? ''),
      )
      renderer = new Cdp(page.webSocketDebuggerUrl)
      await renderer.connect()
      break
    } catch {
      await sleep(250)
    }
  }
  if (!renderer) throw new Error('渲染层 CDP 连接失败')
  await sleep(800)

  // 拦截打开对话框并打开大文档（docPath 经 run 的参数带入模板串）
  await mainCdp.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { dialog } = req('electron')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(docPath)}] })
    return true
  })()`)
  await mainCdp.evalJson(`(() => {
    const req = typeof require === 'function' ? require : global.process.mainModule.require
    const { Menu } = req('electron')
    const m = Menu.getApplicationMenu()
    const fileMenu = m.items.find((i) => i.submenu && i.submenu.items.some((s) => /打开|Open/.test(s.label || '')))
    fileMenu.submenu.items[0].click()
    return true
  })()`)
  await sleep(2600)

  const chars = await renderer.evalJson(
    `document.querySelector('#editor .ProseMirror')?.textContent.length || 0`,
  )
  console.log('文档已打开，字符数:', chars)

  // 开启 CPU 采样，连续输入 40 次（Input.insertText 走真实输入管线）
  // ---------- A/B 输入延迟对比：模拟人类打字节奏（150ms/键 × 25 键） ----------
  // 与 bench 同款探针（input → setTimeout(0) 为同步成本，rAF 为到帧延迟），
  // 但按键间隔远短于防抖窗口，能反映「连续输入期间序列化是否占用输入帧」
  await renderer.evalJson(`(() => {
    window.__ab = { sync: [], frame: [] }
    document.addEventListener('input', () => {
      const t0 = performance.now()
      setTimeout(() => window.__ab.sync.push(Number((performance.now() - t0).toFixed(2))), 0)
      requestAnimationFrame(() => window.__ab.frame.push(Number((performance.now() - t0).toFixed(2))))
    }, { capture: true })
    return true
  })()`)
  for (let i = 0; i < 25; i++) {
    await renderer.evalJson(`document.querySelector('#editor .ProseMirror')?.focus()`)
    await renderer.send('Input.insertText', { text: '字' })
    await sleep(150)
  }
  // 等防抖序列化落盘（不计入打字窗口样本）
  await sleep(1500)
  const ab = await renderer.evalJson(`JSON.stringify(window.__ab)`)
  const abStats = JSON.parse(ab)
  const med = (arr) => {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] ?? 0
  }
  console.log(
    `A/B 人类节奏输入延迟（25 键 × 150ms）：同步中位 ${med(abStats.sync)}ms / 最大 ${Math.max(...abStats.sync)}ms；到帧中位 ${med(abStats.frame)}ms`,
  )

  await renderer.send('Profiler.enable')
  await renderer.send('Profiler.start')
  for (let i = 0; i < 40; i++) {
    await renderer.evalJson(`document.querySelector('#editor .ProseMirror')?.focus()`)
    await renderer.send('Input.insertText', { text: '测' })
    await sleep(120)
  }
  await sleep(800)
  const charsAfter = await renderer.evalJson(
    `document.querySelector('#editor .ProseMirror')?.textContent.length || 0`,
  )
  console.log('输入后字符数:', charsAfter)
  const stop = await renderer.send('Profiler.stop')
  const fs = await import('node:fs')
  const profilePath = join(REPO, '.profile-input.cpuprofile')
  fs.writeFileSync(profilePath, JSON.stringify(stop.profile))
  console.log('profile 已保存:', profilePath)

  // 聚合自耗时 top 24
  const agg = new Map()
  for (const node of stop.profile.nodes) {
    const cf = node.callFrame
    const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').split('/').pop()}:${cf.lineNumber}`
    agg.set(key, (agg.get(key) ?? 0) + (node.hitCount ?? 0))
  }
  const total = [...agg.values()].reduce((a, b) => a + b, 0)
  const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
  console.log(`\n采样总命中 ${total}，Top 自耗时：`)
  for (const [key, hits] of top) {
    console.log(`${String(hits).padStart(6)}  ${((hits / total) * 100).toFixed(1)}%  ${key}`)
  }
}

main()
