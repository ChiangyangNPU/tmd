#!/usr/bin/env node
/**
 * Tauri 版 GUI 自省验收（macOS 优先，Windows 同样可跑）。
 *
 * 为什么需要它：Windows 侧的 GUI 自动化（scripts/tauri-acceptance.mjs）建立在
 * WebView2 的 --remote-debugging-port + CDP 上，WKWebView 没有等价开关，
 * mac 一直只能走人工清单。本脚本改走「Rust 侧原生 evaluateJavaScript」通道：
 *
 *   Node 生成步骤文件 → 启动应用（env 注入）→ 渲染层 ready 后
 *   src-tauri/src/acceptance.rs 逐行执行 JS 并落盘 → Node 读结果断言
 *
 * 覆盖范围：DOM 状态、壳层注入契约、JS→invoke→Rust→磁盘 全链路。
 * **不覆盖**：真实 OS 级按键、NSOpenPanel 等原生面板、拖拽移窗、首帧白闪
 * ——这几项仍需人工或外部 AX/CGEvent 方案（见 docs/验收-tauri-转正.md）。
 *
 * 用法：
 *   node scripts/tauri-mac-check.mjs
 *   TMD_APP_PATH=/Applications/TMD.app node scripts/tauri-mac-check.mjs
 *   TMD_APP_BIN=src-tauri/target/debug/tmd node scripts/tauri-mac-check.mjs  # 开发构建
 *
 * mac 注意：release 必须用 .app 形态（open --env 启动）；裸 release 二进制缺少
 * bundle 上下文，页面不会 ready，脚本会直接拒绝而不是干等超时。debug 构建走
 * devUrl，需同时起 vite。
 *
 * @author chiangyang
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'

const IS_MAC = platform() === 'darwin'
const APP_PATH = process.env.TMD_APP_PATH ?? '/Applications/TMD.app'
const APP_BIN = process.env.TMD_APP_BIN ?? ''
const APP_EXE = process.env.TMD_APP_EXE ?? path.join('src-tauri', 'target', 'release', 'tmd.exe')
const TIMEOUT_MS = Number(process.env.TMD_CHECK_TIMEOUT ?? 90_000)
const STEP_DELAY_MS = Number(process.env.TMD_EVAL_STEP_DELAY_MS ?? 500)

const RESULT_PATH = process.env.TMD_EVAL_OUT ?? path.join(tmpdir(), 'tmd-eval-result.json')
const STEPS_PATH = path.join(tmpdir(), `tmd-eval-steps-${process.pid}.js`)
const FIXTURE_PATH = path.join(tmpdir(), `tmd-acceptance-fixture-${process.pid}.md`)
// 数据隔离：history/logs 走 TMD_HOME_DIR，shell-state/ai-config 走 TMD_DATA_DIR，
// 避免验收实例读写用户真实档案。注意 localStorage/WebKit 缓存由 identifier 决定，
// 仍与正式版共享——断言里不要写 localStorage。
const SANDBOX_HOME = path.join(tmpdir(), `tmd-acceptance-home-${process.pid}`)
const SANDBOX_DATA = path.join(tmpdir(), `tmd-acceptance-data-${process.pid}`)
const FIXTURE_TEXT = '你好 TMD acceptance\n'

/** 应用是否已在运行：单实例锁会把新进程转交给它，env 注入等于白做 */
function assertNotRunning() {
  if (IS_MAC) {
    try {
      execFileSync('pgrep', ['-f', `${APP_PATH}/Contents/MacOS`], { stdio: 'pipe' })
      fail('检测到 TMD 正在运行：请先退出应用（单实例锁会吞掉本次启动的 env 注入）')
    } catch {
      // pgrep 非零退出 = 没在跑，正常
    }
  }
}

/** 清掉本次运行的全部临时产物（失败路径同样调用，避免在 tmp 里堆垃圾） */
function cleanup() {
  rmSync(STEPS_PATH, { force: true })
  rmSync(FIXTURE_PATH, { force: true })
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  rmSync(SANDBOX_DATA, { recursive: true, force: true })
}

function fail(msg) {
  console.error(`[tauri-mac-check] ${msg}`)
  cleanup()
  process.exit(1)
}

const PROSE = `document.querySelector('.ProseMirror')`

/**
 * 派发键盘事件到编辑器元素：需落在 .ProseMirror 上并 bubbles，
 * 才能同时触达 tiptap/prosemirror keymap 与 window 上的全局快捷键处理器
 * （派发到 window 只会命中后者，格式化类快捷键必然失效——已实测）。
 */
function press(key, code, extra = '') {
  const mod = IS_MAC ? 'metaKey' : 'ctrlKey'
  const mods = extra.includes('shift') ? `${mod}:true,shiftKey:true` : `${mod}:true`
  return `(function(){var pm=${PROSE};pm.focus();pm.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},code:${JSON.stringify(code)},${mods},bubbles:true,cancelable:true}));return 'sent'})()`
}

function countOf(selector) {
  return `(function(){var pm=${PROSE};return {n:pm?pm.querySelectorAll(${JSON.stringify(selector)}).length:-1}})()`
}

/**
 * 步骤定义。约束来自 export_native::eval_js 的契约：
 * 每行一个**同步**表达式且返回可 JSON 序列化的值，Promise 不会被等待
 * ——异步链路一律拆成「发起」+「下一拍读全局变量」两步。
 *
 * id 用于断言定位，避免手工维护步骤下标（扩容后极易错位）。
 */
function buildSteps(fixturePath) {
  const readPath = JSON.stringify(fixturePath)
  const overlayOpen = (id) =>
    `(function(){var el=document.getElementById(${JSON.stringify(id)});return {visible:!!el&&!el.hasAttribute('hidden')}})()`
  return [
    {
      id: 'editor-mounted',
      expr: `(function(){var p=${PROSE};return {prose:!!p,toolbar:document.querySelectorAll('.toolbar button').length}})()`,
    },
    {
      id: 'shell-contract',
      expr: `(function(){var a=window.tmdAPI;return {api:!!a,isNative:!!(a&&a.isNative),picgo:a&&a.capabilities?a.capabilities.picgo:null}})()`,
    },
    {
      id: 'read-dispatch',
      expr: `(window.__tmdCheckRead='pending',window.tmdAPI.readFile(${readPath}).then(function(r){window.__tmdCheckRead={ok:true,encoding:r&&r.encoding,content:r&&r.content}}).catch(function(e){window.__tmdCheckRead={ok:false,err:String(e)}}),'dispatched')`,
    },
    { id: 'read-result', expr: 'window.__tmdCheckRead' },
    {
      // 准备：用编辑器内的 Range 全选 → delete → 插入固定文本。
      // 必须先 delete：文档持久化（localStorage）不受 TMD_HOME_DIR/TMD_DATA_DIR
      // 隔离，上一轮成功跑完会把 <p><mark>验收文本</mark></p> 存下来，下一轮
      // 启动即恢复；只做「全选 + insertText」的话文字换了但 <mark> 外壳仍在，
      // 随后再按 Cmd+Shift+H 变成「取消高亮」，断言表现为 PASS/FAIL 交替。
      id: 'prepare',
      expr: `(function(){var pm=${PROSE};pm.focus();var r=document.createRange();r.selectNodeContents(pm);var s=window.getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('delete');document.execCommand('insertText',false,'验收文本');return {text:pm.textContent,overridden:!!localStorage.getItem('tmd:shortcuts')}})()`,
    },
    {
      // 全选必须走 ProseMirror 自己的 Mod+A（baseKeymap 的 selectAll）：它同步
      // 改写 state.selection。此前用 execCommand('selectAll') 只改 DOM 选区，
      // 下一步 press() 里的 pm.focus() 会拿尚未同步的旧 state 把 DOM 选区重置，
      // 命令退化成「只写 storedMarks」，表现为事件被消费但 mark/strong 为 0。
      id: 'select-all',
      expr: press('a', 'KeyA'),
    },
    { id: 'send-bold', expr: press('b', 'KeyB') },
    { id: 'bold-on', expr: countOf('strong') },
    { id: 'send-bold-off', expr: press('b', 'KeyB') },
    { id: 'bold-off', expr: countOf('strong') },
    { id: 'send-h1', expr: press('1', 'Digit1') },
    { id: 'h1-on', expr: countOf('h1') },
    { id: 'send-body', expr: press('0', 'Digit0') },
    {
      id: 'body-off',
      expr: `(function(){var pm=${PROSE};return {h1:pm.querySelectorAll('h1').length,h2:pm.querySelectorAll('h2').length}})()`,
    },
    {
      // 标题切换后选区可能收缩为光标，行内标记类命令（高亮）在空选区上只写
      // storedMarks 不产 mark；同样用 Mod+A 把全选写进 state（见 select-all 注释）
      id: 'reselect',
      expr: press('a', 'KeyA'),
    },
    { id: 'send-highlight', expr: press('h', 'KeyH', 'shift') },
    { id: 'highlight-on', expr: countOf('mark') },
    { id: 'send-linkbar', expr: press('k', 'KeyK') },
    { id: 'linkbar-open', expr: overlayOpen('link-bar') },
    { id: 'send-escape-linkbar', expr: press('Escape', 'Escape') },
    { id: 'linkbar-closed', expr: overlayOpen('link-bar') },
    { id: 'send-settings', expr: press(',', 'Comma') },
    { id: 'settings-open', expr: overlayOpen('settings-overlay') },
    { id: 'send-escape-settings', expr: press('Escape', 'Escape') },
    { id: 'settings-closed', expr: overlayOpen('settings-overlay') },
  ]
}

/** 生成步骤文件：每步前写一行注释标识 id，Rust 侧会跳过 // 行 */
function renderStepFile(steps) {
  const lines = []
  for (const step of steps) {
    lines.push(`// ${step.id}`)
    lines.push(step.expr)
  }
  lines.push('')
  return lines.join('\n')
}

const STEP_INDEX = new Map()
const STEP_DEFS = buildSteps('__FIXTURE__').map((step, i) => {
  STEP_INDEX.set(step.id, i)
  return step
})

/** 按 id 取某步的返回值 */
const at = (id) => (steps) => steps[STEP_INDEX.get(id)]?.value

const checks = [
  {
    id: 'editor-mounted',
    label: '编辑器挂载 + 工具栏按钮存在',
    pick: at('editor-mounted'),
    pass: (v) => !!v && v.prose === true && Number(v.toolbar) > 0,
  },
  {
    id: 'shell-contract',
    label: 'tmdAPI 注入成功且能力声明正确（picgo=true）',
    pick: at('shell-contract'),
    pass: (v) => !!v && v.api === true && v.isNative === true && v.picgo === true,
  },
  {
    id: 'read-file',
    label: 'readFile 通道端到端（UTF-8 内容回读一致）',
    pick: at('read-result'),
    pass: (v) =>
      !!v &&
      v.ok === true &&
      typeof v.content === 'string' &&
      v.content.replace(/\r\n/g, '\n') === FIXTURE_TEXT,
  },
  {
    id: 'fmt-bold',
    label: 'Cmd/Ctrl+B 加粗且再按取消（双触发回归）',
    pick: (steps) => ({ on: at('bold-on')(steps), off: at('bold-off')(steps) }),
    pass: (v) => Number(v.on?.n) >= 1 && Number(v.off?.n) === 0,
    detail: (v) => `on=${v.on?.n} off=${v.off?.n}`,
  },
  {
    id: 'fmt-h1',
    label: 'Cmd/Ctrl+1 → H1',
    pick: at('h1-on'),
    pass: (v) => Number(v?.n) >= 1,
  },
  {
    id: 'fmt-body',
    label: 'Cmd/Ctrl+0 → 正文（标题样式清零）',
    pick: at('body-off'),
    pass: (v) => !!v && v.h1 === 0 && v.h2 === 0,
  },
  {
    id: 'fmt-highlight',
    label: 'Cmd/Ctrl+Shift+H → 高亮',
    pick: at('highlight-on'),
    pass: (v) => Number(v?.n) >= 1,
  },
  {
    id: 'linkbar',
    label: 'Cmd/Ctrl+K 打开链接条，Esc 关闭',
    pick: (steps) => ({ open: at('linkbar-open')(steps), closed: at('linkbar-closed')(steps) }),
    pass: (v) => v.open?.visible === true && v.closed?.visible === false,
    detail: (v) => `open=${v.open?.visible} closed=${v.closed?.visible}`,
  },
  {
    id: 'settings',
    label: 'Cmd/Ctrl+, 打开设置面板，Esc 关闭',
    pick: (steps) => ({
      open: at('settings-open')(steps),
      closed: at('settings-closed')(steps),
    }),
    pass: (v) => v.open?.visible === true && v.closed?.visible === false,
    detail: (v) => `open=${v.open?.visible} closed=${v.closed?.visible}`,
  },
]

function launch(env) {
  if (APP_BIN) {
    if (!existsSync(APP_BIN)) fail(`TMD_APP_BIN 不存在：${APP_BIN}`)
    // 实测结论：mac 上裸 release 二进制缺少 bundle 上下文，应用能起但页面不 ready，
    // 只会白等 90s 超时。release 验收必须走 .app + TMD_APP_PATH。
    if (IS_MAC && APP_BIN.includes(`${path.sep}release${path.sep}`))
      fail(
        `mac 上不支持裸 release 二进制：${APP_BIN}\n` +
          '  请用 TMD_APP_PATH 指向 .app（tauri build --bundles app）；\n' +
          '  TMD_APP_BIN 仅用于 debug 构建（需配合 vite dev server，走 devUrl）。',
      )
    spawn(APP_BIN, [], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } }).unref()
    return
  }
  if (IS_MAC) {
    if (!existsSync(APP_PATH))
      fail(`应用不存在：${APP_PATH}（先用 TMD_APP_PATH 指定，或 npm run dist:tauri:dir）`)
    // open --env 需要 macOS 12.4+；应用会被激活，WKWebView 正常合成
    execFileSync('open', [
      '-a',
      APP_PATH,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ])
    return
  }
  if (!existsSync(APP_EXE)) fail(`应用不存在：${APP_EXE}（先 npm run dist:tauri:win:dir）`)
  spawn(APP_EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } }).unref()
}

function waitForResult() {
  const started = Date.now()
  while (Date.now() - started < TIMEOUT_MS) {
    if (existsSync(RESULT_PATH)) {
      try {
        const parsed = JSON.parse(readFileSync(RESULT_PATH, 'utf8'))
        if (parsed && Array.isArray(parsed.steps)) return parsed
      } catch {
        // 文件正在写，下一轮再读
      }
    }
    // 同步 sleep：Windows 无 sleep 命令，且这里在轮询循环内，用 Atomics 最省事
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return null
}

function main() {
  assertNotRunning()
  rmSync(RESULT_PATH, { force: true })
  writeFileSync(FIXTURE_PATH, FIXTURE_TEXT, 'utf8')
  writeFileSync(STEPS_PATH, renderStepFile(buildSteps(FIXTURE_PATH)), 'utf8')

  console.log(`[tauri-mac-check] 步骤文件 ${STEPS_PATH}`)
  launch({
    TMD_EVAL_SCRIPT: STEPS_PATH,
    TMD_EVAL_OUT: RESULT_PATH,
    TMD_EVAL_STEP_DELAY_MS: String(STEP_DELAY_MS),
    // 验收实例跑完即退，不留在桌面打扰用户（drivers 侧 std::process::exit）
    TMD_EVAL_EXIT: '1',
    TMD_HOME_DIR: SANDBOX_HOME,
    TMD_DATA_DIR: SANDBOX_DATA,
  })

  const report = waitForResult()
  if (!report) {
    fail(
      `等待结果超时（${TIMEOUT_MS}ms）：${RESULT_PATH}\n` +
        '  排查：应用是否已在运行？mac 上 open --env 是否可用（需 macOS 12.4+）？\n' +
        '  也可用 TMD_APP_BIN 指向开发构建直接 spawn。',
    )
  }

  if (report.fatal) fail(`驱动层失败：${report.fatal}`)

  let passed = 0
  let failed = 0
  checks.forEach((check) => {
    const value = check.pick(report.steps)
    const ok = check.pass(value)
    if (ok) passed += 1
    else failed += 1
    const detail = ok
      ? ''
      : check.detail
        ? `（${check.detail(value)}）`
        : `\n    实际值: ${JSON.stringify(value)}`
    console.log(
      `[tauri-mac-check] ${ok ? 'PASS' : 'FAIL'} ${check.id.padEnd(16)} ${check.label}${detail}`,
    )
  })

  // localStorage 未做隔离（由 identifier 决定，env 覆盖不到）：
  // 用户自定义过快捷键时，格式化类断言仍按默认键位派发，结果可能失真
  if (at('prepare')(report.steps)?.overridden) {
    console.log('[tauri-mac-check] WARN 检测到自定义快捷键（tmd:shortcuts），格式化类断言可能失真')
  }

  // 步骤自身求值异常（表达式抛错 / 未返回）也视为失败，避免静默漏检
  report.steps.forEach((step) => {
    if (!step.ok) {
      failed += 1
      console.log(`[tauri-mac-check] FAIL step#${step.index} 求值异常: ${step.error}`)
    }
  })

  const summary = `${passed}/${checks.length} 项断言通过`
  console.log(
    `[tauri-mac-check] 结果 ${summary}${failed ? `，${failed} 项失败` : ''}（原始输出 ${RESULT_PATH}）`,
  )
  cleanup()
  process.exit(failed === 0 ? 0 : 1)
}

main()
