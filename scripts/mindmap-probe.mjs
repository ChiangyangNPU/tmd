/**
 * Mermaid mindmap 渲染真机探针（一次性验证脚本）：
 * 真实启动应用并打开含 mindmap 的笔记，断言——
 * 1. Mermaid SVG 渲染出现（非错误态）
 * 2. SVG 内容确为思维导图（含根节点文本、节点元素）
 * 3. 截图存盘供人工查看（/tmp/tmd-mindmap.png + 裁剪特写）
 */
import { mkdtemp, writeFile, rm, writeFile as wf } from 'node:fs/promises'
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

const homeDir = await mkdtemp(path.join(tmpdir(), 'tmd-mm-home-'))
const profile = await mkdtemp(path.join(tmpdir(), 'tmd-mm-profile-'))
const notesDir = await mkdtemp(path.join(tmpdir(), 'tmd-mm-notes-'))
const notePath = path.join(notesDir, 'mindmap.md')
await writeFile(
  notePath,
  [
    '# 思维导图测试',
    '',
    '```mermaid',
    'mindmap',
    '  root((TMD))',
    '    写作',
    '      所见即所得',
    '      源码模式',
    '    图表',
    '      Mermaid',
    '      KaTeX',
    '    管理',
    '      多标签',
    '      文件树',
    '```',
    '',
  ].join('\n'),
)

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
  await renderer.send('Page.enable')

  async function ev(expression) {
    const res = await renderer.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails)
      throw new Error('EVAL: ' + JSON.stringify(res.exceptionDetails).slice(0, 600))
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

  check(
    '编辑器挂载且 mindmap.md 已打开',
    await waitFor(
      `document.querySelector('#editor .milkdown, #editor .ProseMirror') && /mindmap\\.md/.test(document.querySelector('#tab-bar')?.textContent ?? '')`,
      20000,
    ),
  )

  // Mermaid 渲染（400ms 防抖 + 异步渲染），轮询 SVG 出现
  check(
    'Mermaid SVG 已渲染',
    await waitFor(
      `(() => { const svg = document.querySelector('.page-scroll .mermaid-render svg'); return !!svg && svg.getBoundingClientRect().width > 50 })()`,
      20000,
    ),
  )

  // SVG 内容确为思维导图：含根节点文本与多个节点元素
  const svgInfo = await ev(`(() => {
    const svg = document.querySelector('.page-scroll .mermaid-render svg')
    if (!svg) return null
    return {
      text: svg.textContent ?? '',
      sections: svg.querySelectorAll('g.section').length || svg.querySelectorAll('[data-id]').length,
      edges: svg.querySelectorAll('path.edge, path.flowchart-link, .edgePaths path').length,
      w: Math.round(svg.getBoundingClientRect().width),
      h: Math.round(svg.getBoundingClientRect().height),
    }
  })()`)
  check(
    'SVG 为思维导图（含根节点 TMD 文本）',
    !!svgInfo && svgInfo.text.includes('TMD'),
    JSON.stringify(svgInfo),
  )
  // 诊断：渲染容器实际状态
  try {
    const diag = await ev(`(() => {
      const pres = [...document.querySelectorAll('.page-scroll pre')].map(el => ({
        cls: el.className,
        dt: el.dataset.type ?? '',
        head: (el.textContent ?? '').slice(0, 40),
      }))
      return { preCount: pres.length, pres, pageHead: (document.querySelector('.page-scroll')?.textContent ?? '').slice(0, 100) }
    })()`)
    console.log('  [diag]', JSON.stringify(diag))
  } catch (e) {
    console.log('  [diag] 诊断失败:', String(e).slice(0, 200))
  }
  check(
    'SVG 尺寸正常（非错误占位）',
    !!svgInfo && svgInfo.w > 100 && svgInfo.h > 100,
    `${svgInfo?.w}x${svgInfo?.h}`,
  )
  check(
    '无错误态（无「图表错误」文案）',
    await ev(`!document.querySelector('.page-scroll')?.textContent.includes('错误')`),
  )

  // 截图：整窗 + mindmap 块特写
  const shot = await renderer.send('Page.captureScreenshot', { format: 'png' })
  await wf('/tmp/tmd-mindmap-full.png', Buffer.from(shot.data, 'base64'))
  const clipBox = await ev(`(() => {
    const el = document.querySelector('.page-scroll .mermaid-render')
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16, scale: 1 }
  })()`)
  const shotClip = await renderer.send('Page.captureScreenshot', { format: 'png', clip: clipBox })
  await wf('/tmp/tmd-mindmap-closeup.png', Buffer.from(shotClip.data, 'base64'))
  check(
    '截图已存盘（/tmp/tmd-mindmap-full.png + closeup）',
    existsSync('/tmp/tmd-mindmap-closeup.png'),
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
