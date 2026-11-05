/**
 * 转正验收补充组：挂载文件夹（H）与粘贴图片（I）。
 *
 * H 组绕开原生打开对话框的方式：渲染层 shim 的 impl 对象可从页面侧打桩
 * （window.tmdAPI.openFolder = async () => dir），随后 JS 点击工具栏按钮——
 * 之后的 readDir（真实 Rust 命令）/pushFolder/排序/渲染全走真实链路，
 * 只有「原生对话框返回路径」一步被替换（与 desktop-app-check.mjs 的
 * installDialogStubs 同思路）。
 *
 * I 组粘贴图片：真实剪贴板路径（PowerShell STA 写入位图 → CDP 发 Ctrl+V，
 * WebView2 转 paste 事件）；若 WebView2 剪贴板转换不配合，回落合成
 * ClipboardEvent（DataTransfer + File，仍走 ProseMirror handlePaste 之后的
 * 全部真实链路）。
 *
 * 用法：node scripts/tauri-acceptance-mount.mjs [--kill] [--exe path]
 *
 * @author chiangyang
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.TMD_E2E_CDP_PORT ?? 9225)
const KILL_STALE = process.argv.includes('--kill')
const exeArgIdx = process.argv.indexOf('--exe')
const EXE =
  exeArgIdx > 0 && process.argv[exeArgIdx + 1]
    ? process.argv[exeArgIdx + 1]
    : join(REPO, 'src-tauri', 'target', 'release', 'tmd.exe')

if (!existsSync(EXE)) {
  console.error(`[acc-mount] 找不到 ${EXE}`)
  process.exit(2)
}

const results = []
const GROUPS = {}
function record(group, name, ok, detail = '') {
  if (!GROUPS[group]) GROUPS[group] = []
  GROUPS[group].push({ name, ok, detail })
  results.push({ group, name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${name}${detail ? `  (${detail})` : ''}`)
}

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

async function waitForPage(port, timeoutMs = 25000, childExited = () => false) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childExited()) throw new Error('应用进程已退出')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 未就绪 */
    }
    await sleep(250)
  }
  throw new Error(`等待 CDP 端口 ${port} 超时`)
}

async function evalJson(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(`页面求值异常: ${result.exceptionDetails.text}`)
  return result.result?.value
}

async function pressKey(cdp, { key, code, vk, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 列出与目标 exe 同路径的运行实例（单实例锁按 identifier 生效，同路径必同锁；
 *  严禁按进程名匹配——会把用户的 Electron 正式版 TMD.exe 一并杀掉） */
function runningInstances() {
  try {
    const target = EXE.toLowerCase()
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-Process tmd -ErrorAction SilentlyContinue | ForEach-Object { "{0}`t{1}" -f $_.Id, $_.Path }',
      ],
      { encoding: 'utf8' },
    )
    return out
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter(([id, path]) => Number.isInteger(Number(id)) && path && path.toLowerCase() === target)
      .map(([id]) => Number(id))
  } catch {
    return []
  }
}

/** 造 fixture：中英文混合名（拼音排序判别）+ 双链两页 + 子目录 */
function makeFixture(dir) {
  const files = {
    '啊.md': '# 啊\n\n被 [[中]] 引用。\n',
    '北.md': '# 北\n',
    '中.md': '# 中\n\n引用 [[啊|别名页]]。\n',
    'Zebra.md': '# Zebra\n',
    'apple.md': '# apple\n',
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  mkdirSync(join(dir, '资料夹'))
  writeFileSync(join(dir, '资料夹', 'nested.md'), '# nested\n')
  return Object.keys(files)
}

/** 预期顺序：sort_key = 逐字符拼音（非中文保留），按字节升序。
 *  Z(0x5A) < a.md(啊) < apple < bei(北) < zhong(中) < ziliaojia(资料夹) */
const EXPECTED_ORDER = ['Zebra.md', '啊.md', 'apple.md', '北.md', '中.md', '资料夹']

/** PowerShell STA：生成 64x64 红 PNG 并写入剪贴板（返回 PNG 文件路径） */
function setClipboardImage() {
  const pngPath = join(tmpdir(), `tmd-acc-clip-${Date.now()}.png`)
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Red)
$g.Dispose()
$bmp.Save('${pngPath.replaceAll('\\', '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
[System.Windows.Forms.Clipboard]::SetImage($bmp)
Write-Output 'CLIP_OK'
`
  const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
  })
  if (!out.includes('CLIP_OK')) throw new Error(`剪贴板写入失败: ${out}`)
  return pngPath
}

async function main() {
  if (KILL_STALE) {
    const stale = runningInstances()
    if (stale.length) {
      console.log(`[acc-mount] --kill：结束残留实例 PID ${stale.join(', ')}`)
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-Process tmd -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower() -eq '${EXE.replaceAll('\\', '\\\\').toLowerCase()}' } | Stop-Process -Force`,
      ])
      await sleep(1200)
    }
  }

  const userData = mkdtempSync(join(tmpdir(), 'tmd-accm-'))
  const fixtureDir = mkdtempSync(join(tmpdir(), 'tmd-accm-fx-'))
  makeFixture(fixtureDir)
  console.log(`[acc-mount] 启动 ${EXE}\n  fixture=${fixtureDir}`)

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: userData,
    },
    stdio: 'ignore',
  })
  let childExited = false
  child.on('exit', () => {
    childExited = true
  })

  let cdp
  let pngPath = null
  try {
    let page
    try {
      page = await waitForPage(PORT, 25000, () => childExited)
    } catch (err) {
      if (childExited) throw new Error('应用启动后立即退出（--kill 清场）', { cause: err })
      throw err
    }
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')

    // 编辑器就绪
    let mounted = false
    for (let i = 0; i < 60 && !mounted; i++) {
      mounted = await evalJson(cdp, `!!document.querySelector('#editor .ProseMirror')`)
      if (!mounted) await sleep(250)
    }
    if (!mounted) throw new Error('编辑器未挂载')
    await evalJson(cdp, `(() => {
      window.__acc = { errs: [] };
      window.addEventListener('error', (e) => window.__acc.errs.push(String(e.error && e.error.stack || e.message).slice(0, 200)));
      window.addEventListener('unhandledrejection', (e) => window.__acc.errs.push('REJ: ' + String(e.reason).slice(0, 200)));
      return true;
    })()`)

    // ===== H1: 打桩 openFolder → 挂载 fixture =====
    const jsDir = JSON.stringify(fixtureDir.replaceAll('\\', '\\\\'))
    await evalJson(cdp, `window.tmdAPI.openFolder = async () => ${jsDir}; true`)
    await evalJson(cdp, `document.getElementById('open-folder-btn').click(); true`)
    await sleep(900)
    const rootRow = await evalJson(cdp, `(() => {
      const tree = document.getElementById('folder-tree');
      if (!tree) return null;
      const root = tree.querySelector('.tree-folder .tree-file-name');
      return root ? root.textContent : null;
    })()`)
    record('H', '挂载文件夹（打桩对话框 → 真实 readDir/渲染）', !!rootRow, `根行=${rootRow}`)

    // ===== H2: 中文拼音排序 =====
    const actualOrder = await evalJson(cdp, `(() => {
      const tree = document.getElementById('folder-tree');
      // 只取根的直接子行（排除 .folder-sub 内的嵌套行）
      const rows = [...(tree.querySelector('.folder-sub')?.children ?? [])].filter(el => el.classList.contains('tree-file') || el.classList.contains('tree-folder'));
      return rows.map(r => r.querySelector('.tree-file-name')?.textContent).filter(Boolean);
    })()`)
    const orderOk =
      Array.isArray(actualOrder) &&
      EXPECTED_ORDER.length === actualOrder.length &&
      EXPECTED_ORDER.every((n, i) => n === actualOrder[i])
    record('H', '中文拼音排序（啊<北<中，英文按 key 字节序混排）', orderOk,
      `实际=[${(actualOrder || []).join(', ')}]`)

    // ===== H3: 点树行打开文件 → 活动标签 =====
    await evalJson(cdp, `(() => {
      const tree = document.getElementById('folder-tree');
      const row = [...(tree.querySelector('.folder-sub')?.children ?? [])].filter(el => el.classList.contains('tree-file')) 
        .find(r => r.querySelector('.tree-file-name')?.textContent === '中.md');
      row?.click();
      return !!row;
    })()`)
    await sleep(900)
    const activeTab = await evalJson(cdp, `document.querySelector('.tab.active')?.textContent || ''`)
    record('H', '点树行打开文件 → 活动标签', activeTab.includes('中.md'), `tab=${activeTab.trim()}`)

    // ===== H4: 树行右键菜单 =====
    await evalJson(cdp, `(() => {
      const tree = document.getElementById('folder-tree');
      const row = [...(tree.querySelector('.folder-sub')?.children ?? [])].filter(el => el.classList.contains('tree-file'))
        .find(r => r.querySelector('.tree-file-name')?.textContent === '北.md');
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 8,
      }));
      return true;
    })()`)
    await sleep(400)
    const menuItems = await evalJson(cdp, `(() => {
      const menu = document.querySelector('.file-context-menu');
      if (!menu) return null;
      return [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
    })()`)
    const menuOk = Array.isArray(menuItems) && menuItems.some((t) => t.includes('重命名'))
    record('H', '树行右键菜单（重命名/复制路径/回收站）', menuOk,
      `items=[${(menuItems || []).join(' | ')}]`)
    await pressKey(cdp, { key: 'Escape', code: 'Escape', vk: 27 }); await sleep(250)

    // ===== H5: 双链跳转（打开 中.md → 点 [[啊|别名页]] → 活动标签变 啊.md） =====
    // wikilink 解析依赖异步索引（resolution pending 时不跳转）——用 CDP 真实
    // 鼠标事件（isTrusted=true，与真鼠标同管线）+ 重试
    let tabAfterJump = ''
    let wikilinkFound = false
    for (let attempt = 0; attempt < 6; attempt++) {
      const coord = await evalJson(cdp, `(() => {
        const link = document.querySelector('#editor .wikilink');
        if (!link) return null;
        const r = link.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`)
      if (!coord) break
      wikilinkFound = true
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1,
      })
      await sleep(900)
      tabAfterJump = await evalJson(cdp, `document.querySelector('.tab.active')?.textContent || ''`)
      if (tabAfterJump.includes('啊.md')) break
    }
    record('H', '双链点击跳转（中.md → 啊.md，真实鼠标点击）',
      wikilinkFound && tabAfterJump.includes('啊.md'),
      `link=${wikilinkFound} tab=${tabAfterJump.trim()}`)

    // ===== H6: 反链（啊.md 的反链应列出 中.md） =====
    await pressKey(cdp, { key: 'B', code: 'KeyB', vk: 66, modifiers: 10 }); await sleep(700)
    const backlinks = await evalJson(cdp, `(() => {
      const ov = document.getElementById('backlinks-overlay');
      if (!ov || ov.hidden) return { open: false };
      return { open: true, text: ov.textContent.slice(0, 400) };
    })()`)
    record('H', '反链面板列出引用页（中.md）', !!backlinks?.open && backlinks.text.includes('中'),
      backlinks?.open ? `含中=${backlinks.text.includes('中')}` : '面板未打开')
    await pressKey(cdp, { key: 'Escape', code: 'Escape', vk: 27 }); await sleep(300)

    // ===== H7: 关系图谱 =====
    await pressKey(cdp, { key: 'G', code: 'KeyG', vk: 71, modifiers: 10 }); await sleep(900)
    const graph = await evalJson(cdp, `(() => {
      const ov = document.getElementById('graph-overlay');
      if (!ov || ov.hidden) return { open: false };
      return { open: true, hasCanvasOrSvg: !!ov.querySelector('canvas, svg') };
    })()`)
    record('H', '关系图谱打开（canvas/svg 渲染）', !!graph?.open && graph.hasCanvasOrSvg,
      graph?.open ? `canvas=${graph.hasCanvasOrSvg}` : '未打开')
    await pressKey(cdp, { key: 'Escape', code: 'Escape', vk: 27 }); await sleep(300)

    // ===== I 组：粘贴图片 =====
    // 清空当前文档，聚焦编辑器
    await evalJson(cdp, `(() => {
      const pm = document.querySelector('#editor .ProseMirror');
      pm.focus();
      return true;
    })()`)
    await pressKey(cdp, { key: 'a', code: 'KeyA', vk: 65, modifiers: 2 }); await sleep(150)
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await sleep(200)

    // I1: inline 策略（默认）——真实剪贴板 → Ctrl+V
    try {
      pngPath = setClipboardImage()
      record('I', '剪贴板写入测试图片（PowerShell STA）', true, pngPath)
    } catch (err) {
      record('I', '剪贴板写入测试图片（PowerShell STA）', false, String(err.message).slice(0, 80))
    }
    await pressKey(cdp, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
    await sleep(1200)
    let imgState = await evalJson(cdp, `(() => {
      const img = document.querySelector('#editor img');
      return img ? { src: (img.getAttribute('src') || '').slice(0, 30) } : null;
    })()`)
    if (!imgState) {
      // 回落：合成 ClipboardEvent（DataTransfer + File），仍走 handlePaste 后的真实链路
      console.log('  [i] 真实剪贴板路径未产生粘贴事件，回落合成 ClipboardEvent')
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      await evalJson(cdp, `(async () => {
        const res = await fetch(${JSON.stringify(dataUrl)});
        const blob = await res.blob();
        const file = new File([blob], 'clip.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        document.querySelector('#editor .ProseMirror').dispatchEvent(ev);
        return true;
      })()`)
      await sleep(1000)
      imgState = await evalJson(cdp, `(() => {
        const img = document.querySelector('#editor img');
        return img ? { src: (img.getAttribute('src') || '').slice(0, 30) } : null;
      })()`)
      record('I', '粘贴图片 → 内联（合成事件路径）', !!imgState && imgState.src.startsWith('data:image'),
        imgState ? `src=${imgState.src}…` : '无 img')
    } else {
      record('I', '粘贴图片 → 内联（真实剪贴板 + Ctrl+V）', imgState.src.startsWith('data:image'),
        `src=${imgState.src}…`)
    }

    // I2: assets 策略——当前 tab（啊.md）在 fixture 目录，baseDir 可用。
    // 策略必须走真实 UI 路径改：settings.ts 的模块变量 imageStrategy 只在
    // radio change 事件里同步（getCurrentImageStrategy 读模块变量，非 localStorage）
    await evalJson(cdp, `(() => {
      const radio = document.querySelector('input[name="set-img"][value="assets"]');
      if (!radio) return 'NO_RADIO';
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      return 'CHANGED';
    })()`)
    await sleep(300)
    // 再粘贴一次（剪贴板仍有图）；先拉回焦点
    await evalJson(cdp, `document.querySelector('#editor .ProseMirror').focus(); true`)
    await sleep(150)
    await pressKey(cdp, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
    await sleep(1500)
    // 断言：任一 img 的 src 含 /assets/ 段（装饰器把相对 src 重写为 file:// 绝对地址，
    // 文档数据里才是相对路径；不取 last——imageAttrs 可能产占位节点）
    const findAssetsImg = `(() => {
      const hit = [...document.querySelectorAll('#editor img')]
        .find(i => (i.getAttribute('src') || '').includes('/assets/'));
      // 判定用完整 src 的 includes 结果；展示值截断仅作参考
      return hit ? { ok: true, src: hit.getAttribute('src').slice(0, 40) } : null;
    })()`
    let assetImg = await evalJson(cdp, findAssetsImg)
    if (!assetImg) {
      // 真实剪贴板未生效时补一发合成事件（同一 handler 链路）
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      await evalJson(cdp, `(async () => {
        const res = await fetch(${JSON.stringify(dataUrl)});
        const blob = await res.blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'clip2.png', { type: 'image/png' }));
        document.querySelector('#editor .ProseMirror').dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      })()`)
      await sleep(1200)
      assetImg = await evalJson(cdp, findAssetsImg)
    }
    // 磁盘核验：fixture/assets/image-*.png 是否真实落盘（saveImage 落 dir/assets/）
    let assetFile = null
    try {
      const assetsDir = join(fixtureDir, 'assets')
      if (existsSync(assetsDir)) {
        const list = readdirSync(assetsDir).filter((f) => f.startsWith('image-'))
        assetFile = list[0] ?? null
      }
    } catch { /* ignore */ }
    record('I', 'assets 策略粘贴 → assets/ 落盘 + src 引用',
      !!assetFile && !!assetImg && assetImg.ok === true,
      `磁盘=${assetFile ?? '无'} src=${assetImg ? assetImg.src : '无'}`)
    // 还原策略（避免污染 userData——本实例 userData 是临时的，其实无妨；还原只为语义干净）
    await evalJson(cdp, `localStorage.setItem('tmd:img', 'inline'); true`)

    // ===== G 延伸：全程无未捕获异常 =====
    const errs = await evalJson(cdp, `JSON.stringify((window.__acc?.errs || []).map(e => String(e).slice(0, 200)))`)
    const errList = JSON.parse(errs || '[]')
    record('G', '挂载+粘贴全程无未捕获异常', errList.length === 0, errList.slice(0, 3).join(' | ') || '干净')
  } finally {
    cdp?.close()
    child.kill()
    await sleep(600)
    try {
      rmSync(userData, { recursive: true, force: true })
      rmSync(fixtureDir, { recursive: true, force: true })
      if (pngPath && existsSync(pngPath)) rmSync(pngPath, { force: true })
    } catch {
      /* 占用即留 */
    }
  }

  const pass = results.filter((r) => r.ok === true).length
  const fail = results.filter((r) => r.ok === false).length
  console.log(`\n[acc-mount] 汇总: PASS=${pass} FAIL=${fail}`)
  mkdirSync(join(REPO, 'dist-tauri'), { recursive: true })
  writeFileSync(join(REPO, 'dist-tauri', 'acceptance-mount-result.json'), JSON.stringify({ generatedAt: new Date().toISOString(), groups: GROUPS }, null, 2))
  console.log('[acc-mount] 明细: dist-tauri/acceptance-mount-result.json')
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error(`[acc-mount] 失败: ${err.message}`)
  process.exit(1)
})
