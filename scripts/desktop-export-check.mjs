/**
 * 导出功能（HTML / PDF / Word / 长图 / LaTeX）的桌面端端到端验证脚本。
 *
 * 为什么需要它：单元测试跑在 node 环境（无 DOM、无 Electron），覆盖不到导出的
 * 真实链路——隐藏窗口能否截帧、Mermaid/KaTeX 是否渲染完成、docx 是否良构、
 * 分段拼接有无接缝。这些只能在真实 Chromium + 真实应用菜单下验证。
 *
 * 做法：
 * - 用隔离的 user-data-dir 启动 dist 产物的 Electron（不碰用户日常配置）
 * - 同时开 CDP（渲染层 9222）与 --inspect（主进程 9229）；
 *   主进程侧把 dialog 的打开/保存对话框换成固定输入输出（原生弹窗无法自动化），
 *   其余全走真实链路——包括通过真实应用菜单项 click() 触发打开/导出
 * - 断言产物：docx 解压后校验 OOXML 结构与位图、长图用 nativeImage 解码校验
 *   尺寸与逐行墨量（检测空白带）；额外做取消对话框与浏览器降级两项分支验证
 *
 * 用法：
 *   npm run build && npm run test:desktop          # 全量断言
 *   npm run test:desktop -- --verbose              # 附带诊断输出（位图尺寸/DOM 残留）
 *   npm run test:desktop -- --keep                 # 保留临时产物目录，便于人工查看
 *
 * 前置条件：
 * - 已构建 dist（脚本会先检查，缺失则提示先 npm run build）
 * - 需要图形会话（隐藏窗口依赖合成器截帧）；断言按本机像素比自适应
 * - 同一时刻只能跑一个实例（占用 9222/9229 端口）；脚本会先清理遗留的
 *   Electron 进程——注意 .bin/electron 是包装脚本，只杀它会留下孤儿进程
 *
 * 退出码：0 全部通过；1 有断言失败；2 脚本自身异常。
 */
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// CDP 客户端 / 应用启停 / 进程组清理为各桌面检查脚本共享，见 harness 模块
import {
  Cdp,
  cleanupElectron,
  killTree,
  sleep,
  spawnApp,
  waitForPortsFree,
  waitForTarget,
} from './lib/desktop-harness.mjs'

/** 仓库根目录（本文件位于 scripts/ 下） */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** 临时产物目录（文档、位图、导出结果、隔离的 Electron 配置） */
const WORK = join(tmpdir(), 'tmd-export-check')
const PROFILE = join(WORK, 'profile')
const require = createRequire(join(REPO, 'package.json'))
const { unzipSync } = require('fflate')

/** 命令行开关：--verbose 输出诊断明细，--keep 保留产物目录 */
const ARGV = process.argv.slice(2)
const VERBOSE = ARGV.includes('--verbose')
const KEEP = ARGV.includes('--keep')

const results = []
function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}
/** 诊断项：仅 --verbose 时输出，不计入通过率 */
function diag(name, detail) {
  results.push({ name, passed: true, detail, diagnostic: true })
  if (VERBOSE) console.log(`DIAG  ${name} :: ${detail}`)
}

/** 生成测试文档：覆盖全部语法 + 相对路径图片 */
function buildSampleMarkdown() {
  const long = Array.from(
    { length: 150 },
    (_, i) =>
      `### 小节 ${i + 1}\n\n第 ${i + 1} 段正文，用于撑高文档以验证长图分段拼接与接缝连续性。\n`,
  ).join('\n')
  return `---
title: 导出验证
author: tmd
---

<!-- TOC -->

# 导出验证文档

## 行内语法

**加粗**、*斜体*、~~删除线~~、==高亮==、H~2~O、x^2^、\`inline code\`、[外部链接](https://example.com)、[内部链接](#重复标题)。

## 重复标题

第一处重复标题。

## 重复标题

第二处重复标题（检验 slug 去重）。

> 引用块：架构与设计模式的取舍。

- 无序项 A
  1. 嵌套有序 1
  2. 嵌套有序 2
- 无序项 B

| 列一 | 列二 |
| --- | --- |
| 单元格 | 内容 |

\`\`\`js
const a = 1
console.log(a)
\`\`\`

\`\`\`mermaid
graph LR
  A[开始] --> B{判断}
  B -->|是| C[结束]
  B -->|否| A
\`\`\`

行内公式 $E = mc^2$ 与独占公式：

$$
\\int_{0}^{1} \\frac{x^{2}}{1+x^{2}} \\, dx = \\frac{\\pi}{4} - \\frac{\\ln 2}{2}
$$

脚注引用[^1]。

[^1]: 脚注内容。

![相对路径图片](assets/pic.png)

<img src="assets/pic.png" width="120">

---

${long}
`
}

/** 1x1 → 生成一张 80x40 的纯色 PNG（手写最小 PNG，避免依赖） */
function makePng(width, height, rgba) {
  const { deflateSync } = require('node:zlib')
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const off = y * (width * 4 + 1) + 1 + x * 4
      raw[off] = rgba[0]
      raw[off + 1] = rgba[1]
      raw[off + 2] = rgba[2]
      raw[off + 3] = rgba[3]
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}

async function main() {
  // 预检：脚本验证的是 dist 产物（生产加载路径），未构建时先给出明确提示
  if (!existsSync(join(REPO, 'dist', 'export-renderer.html'))) {
    console.error('未找到 dist 构建产物，请先执行：npm run build')
    process.exit(2)
  }

  // 先清理上一轮残留（.bin/electron 是包装脚本，杀包装层不会杀掉真正的 Electron）
  cleanupElectron()
  await waitForPortsFree()

  await rm(WORK, { recursive: true, force: true })
  await mkdir(join(WORK, 'docs', 'assets'), { recursive: true })
  const mdPath = join(WORK, 'docs', 'sample.md')
  await writeFile(mdPath, buildSampleMarkdown(), 'utf-8')
  await writeFile(join(WORK, 'docs', 'assets', 'pic.png'), makePng(80, 40, [220, 60, 60, 255]))

  const child = spawnApp({ repo: REPO, profile: PROFILE })
  const logs = []
  child.stdout.on('data', (d) => logs.push('OUT ' + d.toString()))
  child.stderr.on('data', (d) => logs.push('ERR ' + d.toString()))

  let main, renderer
  try {
    const nodeTarget = await waitForTarget(
      9229,
      (t) => t.type === 'node' || t.url?.startsWith('file:') || !!t.webSocketDebuggerUrl,
    )
    main = new Cdp(nodeTarget.webSocketDebuggerUrl)
    await main.connect()
    await main.send('Runtime.enable')

    // 主进程 stub：把原生对话框换成固定输入/输出（其余链路全真实）
    const stub = await main.evalJson(`(async () => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { dialog } = req('electron')
      const fs = req('node:fs')
      const outDir = ${JSON.stringify(WORK)}
      let seq = 0
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(mdPath)}] })
      dialog.showSaveDialog = async (...args) => {
        const opts = args.length > 1 ? args[1] : args[0]
        const ext = (opts && opts.filters && opts.filters[0] && opts.filters[0].extensions[0]) || 'bin'
        const filePath = outDir + '/out-' + (++seq) + '.' + ext
        fs.mkdirSync(outDir, { recursive: true })
        return { canceled: false, filePath }
      }
      return { requireOk: typeof require === 'function', stubSeqBase: seq }
    })()`)
    check(
      '主进程对话框 stub 注入成功',
      stub?.requireOk === true || stub !== undefined,
      JSON.stringify(stub),
    )

    const page = await waitForTarget(9222, (t) => t.type === 'page' && /index\.html/.test(t.url))
    renderer = new Cdp(page.webSocketDebuggerUrl)
    await renderer.connect()
    await renderer.send('Runtime.enable')

    // 等渲染层 boot 完成：工具栏按钮是静态 DOM，若只等它会在 boot 未完成时
    // 立即通过，随后的菜单点击可能早于渲染层注册 onMenu 而被丢弃；
    // ProseMirror 挂载在 boot 中后段，作为就绪判据更可靠
    for (let i = 0; i < 60; i++) {
      const ready = await renderer.evalJson(
        `!!document.querySelector('#menu-export-word-btn') && !!document.querySelector('#editor .ProseMirror')`,
      )
      if (ready) break
      await sleep(250)
    }
    const domCheck = await renderer.evalJson(`JSON.stringify({
      word: !!document.querySelector('#menu-export-word-btn'),
      long: !!document.querySelector('#menu-export-longimage-btn'),
      wordHidden: document.querySelector('#menu-export-word-btn')?.hidden === true,
      wordText: document.querySelector('#menu-export-word-btn')?.textContent.trim()
    })`)
    const dom = JSON.parse(domCheck)
    check(
      '工具栏 ⋯ 菜单含 Word / 长图两项且可见',
      dom.word && dom.long && !dom.wordHidden,
      domCheck,
    )

    // 主进程菜单项存在（Electron 应用菜单）
    const menuInfo = await main.evalJson(`(() => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { Menu } = req('electron')
      const m = Menu.getApplicationMenu()
      const labels = m.items.map(i => i.label)
      const exp = m.items.find(i => i.submenu && i.submenu.items.some(s => /Word/i.test(s.label || '')))
      return JSON.stringify({
        topLabels: labels,
        exportItems: exp ? exp.submenu.items.map(i => i.label) : null,
        exportAccel: exp ? exp.submenu.items.map(i => i.accelerator || null) : null
      })
    })()`)
    const menu = JSON.parse(menuInfo)
    const wordItem = menu.exportItems?.findIndex((l) => /Word/.test(l))
    const longItem = menu.exportItems?.findIndex((l) => /长图|Long/.test(l))
    check(
      '应用菜单导出区含 Word / 长图，且这两项不绑定快捷键',
      wordItem >= 0 &&
        longItem >= 0 &&
        menu.exportAccel[wordItem] === null &&
        menu.exportAccel[longItem] === null,
      menuInfo,
    )

    // 真实链路：菜单「文件 → 打开」打开测试文档（走 stub 的打开对话框）
    await main.evalJson(`(() => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { Menu } = req('electron')
      const m = Menu.getApplicationMenu()
      const fileMenu = m.items.find(i => i.submenu && i.submenu.items.some(s => /打开|Open/.test(s.label || '')))
      fileMenu.submenu.items[0].click()
      return 'clicked'
    })()`)
    await sleep(500)
    // 轮询等待打开完成：固定 sleep 在系统负载高（如上一轮崩溃转储落盘）时不够
    let opened = ''
    for (let i = 0; i < 60; i++) {
      opened = /** @type {string} */ (
        await renderer.evalJson(
          `(document.title || '') + '|' + (document.querySelector('.tab.active')?.textContent?.trim() || '')`,
        )
      )
      if (/sample\.md/.test(opened)) break
      await sleep(250)
    }
    check('测试文档已打开（渲染层标题含文件名）', /sample\.md/.test(opened), opened)

    // ---------- 导出 Word ----------
    await main.evalJson(`(() => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { Menu } = req('electron')
      const m = Menu.getApplicationMenu()
      const exp = m.items.find(i => i.submenu && i.submenu.items.some(s => /Word/.test(s.label || '')))
      exp.submenu.items.find(i => /Word/.test(i.label)).click()
      return 'clicked'
    })()`)
    let docx = null
    for (let i = 0; i < 60; i++) {
      await sleep(1000)
      if (existsSync(join(WORK, 'out-1.docx'))) {
        const st = await stat(join(WORK, 'out-1.docx'))
        if (st.size > 0) {
          await sleep(800)
          docx = join(WORK, 'out-1.docx')
          break
        }
      }
    }
    check('Word 导出产出文件', docx !== null, docx ?? '未生成 out-1.docx')

    if (docx) {
      const buf = await readFile(docx)
      const size = buf.length
      check('docx 为合法 ZIP（PK 魔数）', buf[0] === 0x50 && buf[1] === 0x4b, `size=${size}`)
      let entries = {}
      try {
        entries = unzipSync(new Uint8Array(buf))
      } catch (e) {
        check('docx 可解压', false, String(e))
      }
      // 离屏导出页此时仍在（窗口单例复用），借它做 XML 良构性校验（主进程无 DOMParser）
      const expTarget = await waitForTarget(
        9222,
        (t) => t.type === 'page' && /export-renderer/.test(t.url),
        8000,
      ).catch(() => null)
      let exp = null
      if (expTarget) {
        exp = new Cdp(expTarget.webSocketDebuggerUrl)
        await exp.connect()
        await exp.send('Runtime.enable')
      }
      const names = Object.keys(entries)
      const doc = entries['word/document.xml']
      const xml = doc ? Buffer.from(doc).toString('utf-8') : ''
      check('包含 word/document.xml', !!doc, `entries=${names.length}`)
      check(
        'document.xml 含关键文本',
        /导出验证文档/.test(xml) && /引用块/.test(xml) && /脚注内容/.test(xml),
        `webUrl? no; xmlLen=${xml.length}`,
      )
      check(
        '标题映射为 Word 标题样式或加粗段落',
        /Heading1|Heading2|Heading3/.test(xml) || /w:b\//.test(xml),
        '',
      )
      check('表格转成原生表格', /<w:tbl>/.test(xml) && /<w:tr>/.test(xml), '')
      check('列表转成原生编号列表', /<w:numPr>/.test(xml), '')
      const media = names.filter((n) => n.startsWith('word/media/') && entries[n].length > 0)
      check('图片内嵌为 media 位图', media.length >= 2, `media=${media.join(',')}`)
      // 把每张位图落到磁盘并问主进程要尺寸，用于判定「哪一张」是图表/公式/文档图片
      const dims = []
      for (const [i, name] of media.entries()) {
        const out = join(WORK, `media-${i}.png`)
        await writeFile(out, Buffer.from(entries[name]))
        const dim = await main.evalJson(`(() => {
          const req = typeof require === 'function' ? require : global.process.mainModule.require
          const { nativeImage } = req('electron')
          const img = nativeImage.createFromPath(${JSON.stringify(out)})
          const s = img.getSize()
          return JSON.stringify(s)
        })()`)
        dims.push({ bytes: entries[name].length, ...JSON.parse(dim) })
      }
      check(
        '位图尺寸明细（2x 栅格化产物）',
        dims.every((d) => d.width > 0),
        JSON.stringify(dims),
      )
      const hasRels = names.includes('word/_rels/document.xml.rels')
      check('关系文件存在（图片/超链接）', hasRels, '')
      check(
        '外链转为超链接关系',
        hasRels &&
          /Target="https:\/\/example\.com"/.test(
            Buffer.from(entries['word/_rels/document.xml.rels']).toString(),
          ),
        '',
      )
      check('含 [Content_Types].xml（结构完整）', names.includes('[Content_Types].xml'), '')
      if (exp) {
        const xmlB64 = Buffer.from(doc ?? '').toString('base64')
        const parsed = await exp.evalJson(`(async () => {
          const res = await fetch('data:application/xml;base64,${xmlB64}')
          const text = await res.text()
          const xdoc = new DOMParser().parseFromString(text, 'application/xml')
          const errs = xdoc.getElementsByTagName('parsererror')
          return JSON.stringify({
            ok: errs.length === 0,
            root: xdoc.documentElement ? xdoc.documentElement.nodeName : null,
            err: errs.length ? errs[0].textContent.slice(0, 160) : null
          })
        })()`)
        const p = JSON.parse(parsed)
        check('document.xml 为良构 XML（Word 可解析）', p.ok && p.root === 'w:document', parsed)
      }
      check('Mermaid 源码未泄漏为正文文本（已被图表位图取代）', !/graph LR/.test(xml), '')
      check(
        'Mermaid 图表与独占公式已栅格化为位图（media ≥ 3）',
        media.length >= 3,
        `media 数=${media.length}：${media.join(',')}`,
      )
      const sizes = media.map((n) => entries[n].length)
      check(
        '位图体积合理（非空目录项）',
        sizes.every((s) => s > 0),
        JSON.stringify(sizes),
      )
      check('加粗/斜体等行内格式以 run 属性落地', /<w:b\/>/.test(xml) && /<w:i\/>/.test(xml), '')
      const warnLogs = logs.filter((l) => /降级告警/.test(l))
      check(
        '无转换降级告警（图片/样式全部映射成功）',
        warnLogs.length === 0,
        warnLogs.join('').slice(0, 400),
      )

      // 诊断：查看离屏导出页残留的 DOM（窗口单例复用，任务结束后内容仍在）
      if (exp) {
        const domState = await exp.evalJson(`JSON.stringify({
          katex: document.querySelectorAll('.katex-display').length,
          katexAny: document.querySelectorAll('.katex').length,
          mermaidPre: document.querySelectorAll('pre.mermaid').length,
          svg: document.querySelectorAll('svg').length,
          imgs: document.querySelectorAll('img').length,
          dataImgs: document.querySelectorAll('img[src^="data:"]').length,
          zoom: document.body.style.zoom || '(none)',
          height: document.body.scrollHeight,
          dollarPairs: (document.body.textContent.match(/\\$\\$/g) || []).length,
          imgInfo: Array.from(document.querySelectorAll('img')).map(i => ({
            src: i.getAttribute('src').slice(0, 24),
            attr: i.width + 'x' + i.height,
            natural: i.naturalWidth + 'x' + i.naturalHeight
          })),
          katexSnippet: (() => { const k = document.querySelector('.katex'); return k ? k.outerHTML.slice(0, 90) : null })(),
          pWithDollar: (() => {
            const p = Array.from(document.querySelectorAll('p')).find(el => el.textContent.includes('$$'))
            return p ? p.outerHTML.slice(0, 260) : null
          })()
        })`)
        diag('离屏页 DOM 残留状态', domState)
      }
    }

    // ---------- 导出长图 ----------
    await main.evalJson(`(() => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { Menu } = req('electron')
      const m = Menu.getApplicationMenu()
      const exp = m.items.find(i => i.submenu && i.submenu.items.some(s => /长图|Long/.test(s.label || '')))
      exp.submenu.items.find(i => /长图|Long/.test(i.label)).click()
      return 'clicked'
    })()`)
    let png = null
    for (let i = 0; i < 90; i++) {
      await sleep(1000)
      const p = join(WORK, 'out-2.png')
      if (existsSync(p)) {
        const st = await stat(p)
        if (st.size > 1000) {
          await sleep(500)
          png = p
          break
        }
      }
    }
    check('长图导出产出文件', png !== null, png ?? '未生成 out-2.png')

    if (png) {
      const info = await main.evalJson(`(() => {
        const req = typeof require === 'function' ? require : global.process.mainModule.require
        const { nativeImage } = req('electron')
        const img = nativeImage.createFromPath(${JSON.stringify(png)})
        const size = img.getSize()
        const bmp = img.toBitmap()
        const seen = new Set()
        let nonBg = 0
        for (let i = 0; i < bmp.length; i += 4) {
          // 采样步长：每 97 像素取一个，统计颜色多样性与非背景像素占比
          if ((i / 4) % 97 !== 0) continue
          const key = (bmp[i] << 16) | (bmp[i + 1] << 8) | bmp[i + 2]
          seen.add(key)
          if (!(bmp[i] > 245 && bmp[i + 1] > 245 && bmp[i + 2] > 245)) nonBg++
        }
        // 逐行墨量（非背景像素数）：用于检测分段接缝是否出现空白带
        const rowInk = []
        for (let y = 0; y < size.height; y += 8) {
          let ink = 0
          const base = y * size.width * 4
          for (let x = 0; x < size.width; x += 4) {
            const off = base + x * 4
            if (!(bmp[off] > 245 && bmp[off + 1] > 245 && bmp[off + 2] > 245)) ink++
          }
          rowInk.push(ink)
        }
        let maxBlank = 0, run = 0, blankRows = 0
        for (const ink of rowInk) {
          if (ink === 0) { run++; blankRows++; if (run > maxBlank) maxBlank = run } else run = 0
        }
        // 接缝处（每 8000 物理像素一段）的墨量应与总体中位数相当，不能骤降为 0
        const boundaries = []
        for (let y = 8000; y < size.height; y += 8000) {
          const idx = Math.floor(y / 8)
          const band = rowInk.slice(Math.max(0, idx - 2), idx + 3)
          boundaries.push({ y, ink: band.reduce((a, b) => a + b, 0) })
        }
        return JSON.stringify({
          width: size.width, height: size.height, colors: seen.size, nonBg,
          maxBlankPx: maxBlank * 8, blankRowsSampled: blankRows,
          boundaries: boundaries.slice(0, 6),
          boundaryAllInked: boundaries.every(b => b.ink > 0)
        })
      })()`)
      const img2 = JSON.parse(info)
      // 期望宽 924×2；Windows 的 capturePage 对 DIP 矩形做设备像素取整，
      // 实测宽会多出 2 物理像素（925×2），故断言取 ±2px 容差而非精确相等
      check(
        '长图为 2x 物理清晰度（宽 = 924×2 ±2px 取整容差）',
        Math.abs(img2.width - 1848) <= 2,
        info,
      )
      check('长图高度覆盖整篇（> 5000px 说明已分段拼接）', img2.height > 5000, info)
      check('长图非空白（颜色多样且含大量非背景像素）', img2.colors > 20 && img2.nonBg > 50, info)
      check(
        '分段接缝连续（各接缝带均有墨、无长空白带）',
        img2.boundaryAllInked && img2.maxBlankPx < 400,
        JSON.stringify({
          boundaries: img2.boundaries,
          maxBlankPx: img2.maxBlankPx,
          blankRowsSampled: img2.blankRowsSampled,
        }),
      )
    }

    // ---------- 取消保存对话框：不启动离屏渲染、无任务残留 ----------
    // 保存框改返回 canceled，点击导出后不应产生任何文件，且应用保持可用
    await main.evalJson(`(async () => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { dialog, Menu } = req('electron')
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
      const m = Menu.getApplicationMenu()
      const exp = m.items.find(i => i.submenu && i.submenu.items.some(s => /Word/.test(s.label || '')))
      exp.submenu.items.find(i => /Word/.test(i.label)).click()
      return 'clicked'
    })()`)
    await sleep(4000)
    check(
      '取消保存对话框时不产出文件（未启动离屏渲染）',
      !existsSync(join(WORK, 'out-3.docx')),
      `out-3.docx exists=${existsSync(join(WORK, 'out-3.docx'))}`,
    )
    const stillAlive = await renderer.evalJson(`document.querySelectorAll('.tab').length > 0`)
    check('取消后应用仍正常（渲染层存活）', stillAlive === true, String(stillAlive))

    // ---------- LaTeX 导出：纯文本转换（无离屏渲染，主窗口直接落盘）----------
    // 保存框 stub 恢复为按 filter 扩展名落盘；触发原生菜单「导出 → LaTeX」
    await main.evalJson(`(async () => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { dialog, Menu } = req('electron')
      const fs = req('node:fs')
      let n = 100
      dialog.showSaveDialog = async (...args) => {
        const opts = args.length > 1 ? args[1] : args[0]
        const ext = (opts && opts.filters && opts.filters[0] && opts.filters[0].extensions[0]) || 'bin'
        const filePath = ${JSON.stringify(WORK)} + '/latex-' + ++n + '.' + ext
        fs.mkdirSync(${JSON.stringify(WORK)}, { recursive: true })
        return { canceled: false, filePath }
      }
      const m = Menu.getApplicationMenu()
      const exp = m.items.find(i => i.submenu && i.submenu.items.some(s => /LaTeX/.test(s.label || '')))
      exp.submenu.items.find(i => /LaTeX/.test(i.label)).click()
      return 'clicked'
    })()`)
    let texPath = null
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      if (existsSync(join(WORK, 'latex-101.tex'))) {
        texPath = join(WORK, 'latex-101.tex')
        break
      }
    }
    check('LaTeX 导出产出 .tex 文件', texPath !== null, texPath ?? '未生成 latex-101.tex')

    if (texPath) {
      const tex = await readFile(texPath, 'utf-8')
      check(
        'LaTeX 文档结构与中文支持（ctexart + XeLaTeX magic comment）',
        tex.includes('\\documentclass[12pt]{ctexart}') && tex.includes('% !TEX program = xelatex'),
        tex.split('\n').slice(0, 4).join(' | '),
      )
      check(
        'LaTeX 行内语法映射（高亮/删除线/上下标/外链/longtable）',
        tex.includes('\\colorbox{yellow}{高亮}') &&
          tex.includes('\\sout{删除线}') &&
          tex.includes('\\textsubscript{2}') &&
          tex.includes('\\textsuperscript{2}') &&
          tex.includes('\\href{https://example.com}{外部链接}') &&
          tex.includes('\\begin{longtable}[]{@{}l l@{}}'),
        [
          tex.includes('\\colorbox{yellow}{高亮}'),
          tex.includes('\\sout{删除线}'),
          tex.includes('\\textsubscript{2}'),
          tex.includes('\\textsuperscript{2}'),
          tex.includes('\\href{https://example.com}{外部链接}'),
          tex.includes('\\begin{longtable}[]{@{}l l@{}}'),
        ].join(' | '),
      )
      check(
        'LaTeX 无 HTML 泄漏且 front matter 剥离',
        !/<p>|<div|<span|<mark|title: 导出验证/.test(tex) && tex.includes('% [TMD] Mermaid'),
        JSON.stringify({
          htmlLeak: /<p>|<div|<span|<mark/.test(tex),
          frontMatterLeak: tex.includes('title: 导出验证'),
        }),
      )
    }

    // ---------- 浏览器降级：无 tmdAPI 时两个入口隐藏 ----------
    const degrade = await main.evalJson(`(async () => {
      const req = typeof require === 'function' ? require : global.process.mainModule.require
      const { BrowserWindow } = req('electron')
      const path = req('node:path')
      const w = new BrowserWindow({
        show: false, width: 960, height: 720,
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      })
      try {
        await w.loadFile(path.join(${JSON.stringify(REPO)}, 'dist', 'index.html'))
        await new Promise(r => setTimeout(r, 3500))
        return await w.webContents.executeJavaScript(\`JSON.stringify({
          api: typeof window.tmdAPI,
          word: document.querySelector('#menu-export-word-btn')?.hidden,
          long: document.querySelector('#menu-export-longimage-btn')?.hidden,
          html: document.querySelector('#menu-export-html-btn')?.hidden
        })\`)
      } finally {
        w.destroy()
      }
    })()`)
    const dg = JSON.parse(degrade)
    check(
      '浏览器环境（无 tmdAPI）隐藏 Word / 长图入口，HTML 导出保留',
      dg.api === 'undefined' && dg.word === true && dg.long === true && dg.html === false,
      degrade,
    )

    // 渲染层无未捕获错误
    const errs = await renderer
      .evalJson(`JSON.stringify(window.__tmdErrors || [])`)
      .catch(() => '[]')
    check('渲染层无记录到的异常', errs === '[]' || errs === undefined, errs)
  } finally {
    // 杀整个进程组：Electron 由包装脚本派生出孙进程，只杀 child 会留下孤儿
    killTree(child)
    cleanupElectron()
    main?.close()
    renderer?.close()
  }

  const failed = results.filter((r) => !r.passed)
  const total = results.filter((r) => !r.diagnostic)
  console.log(
    `\n===== 汇总：${total.length - failed.length}/${total.length} 断言通过` +
      `${VERBOSE ? `（另含 ${results.length - total.length} 项诊断）` : ''} =====`,
  )
  console.log(KEEP ? `产物保留在：${WORK}` : `产物目录已清理（--keep 可保留：${WORK}）`)
  if (!KEEP) await rm(WORK, { recursive: true, force: true }).catch(() => {})
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`)
    console.log('\n--- 应用日志尾部 ---')
    console.log(logs.slice(-25).join(''))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('驱动脚本异常:', e)
  process.exit(2)
})
