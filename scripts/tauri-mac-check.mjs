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

function fail(msg) {
  console.error(`[tauri-mac-check] ${msg}`)
  process.exit(1)
}

/**
 * 生成步骤文件。约束来自 export_native::eval_js 的契约：
 * 每行一个**同步**表达式且返回可 JSON 序列化的值，Promise 不会被等待
 * ——异步链路一律拆成「发起」+「下一拍读全局变量」两步。
 */
function buildSteps(fixturePath) {
  const readPath = JSON.stringify(fixturePath)
  return [
    '// 1) 编辑器挂载 + 工具栏渲染',
    `(function(){var p=document.querySelector('.ProseMirror');return {prose:!!p,toolbar:document.querySelectorAll('.toolbar button').length}})()`,
    '// 2) 壳层注入契约（tmdAPI 门面 + 能力声明）',
    `(function(){var a=window.tmdAPI;return {api:!!a,isNative:!!(a&&a.isNative),picgo:a&&a.capabilities?a.capabilities.picgo:null}})()`,
    '// 3) 发起 readFile（异步：结果挂到 window.__tmdCheckRead）',
    `(window.__tmdCheckRead='pending',window.tmdAPI.readFile(${readPath}).then(function(r){window.__tmdCheckRead={ok:true,encoding:r&&r.encoding,content:r&&r.content}}).catch(function(e){window.__tmdCheckRead={ok:false,err:String(e)}}),'dispatched')`,
    '// 4) 读回第 3 步的结果（JS → invoke → Rust → 磁盘 全链路）',
    'window.__tmdCheckRead',
    '',
  ].join('\n')
}

const checks = [
  {
    id: 'editor-mounted',
    label: '编辑器挂载 + 工具栏按钮存在',
    // 步骤索引对应 buildSteps 里去掉注释/空行后的表达式顺序
    pick: (steps) => steps[0]?.value,
    pass: (v) => !!v && v.prose === true && Number(v.toolbar) > 0,
  },
  {
    id: 'shell-contract',
    label: 'tmdAPI 注入成功且能力声明正确（picgo=false）',
    pick: (steps) => steps[1]?.value,
    pass: (v) => !!v && v.api === true && v.isNative === true && v.picgo === false,
  },
  {
    id: 'read-file',
    label: 'readFile 通道端到端（UTF-8 内容回读一致）',
    // 第 3 步只负责发起（返回 'dispatched'），异步结果挂全局变量由第 4 步读回
    pick: (steps) => steps[3]?.value,
    pass: (v) =>
      !!v &&
      v.ok === true &&
      typeof v.content === 'string' &&
      v.content.replace(/\r\n/g, '\n') === FIXTURE_TEXT,
  },
]

function launch(env) {
  if (APP_BIN) {
    if (!existsSync(APP_BIN)) fail(`TMD_APP_BIN 不存在：${APP_BIN}`)
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
  writeFileSync(STEPS_PATH, buildSteps(FIXTURE_PATH), 'utf8')

  console.log(`[tauri-mac-check] 步骤文件 ${STEPS_PATH}`)
  launch({
    TMD_EVAL_SCRIPT: STEPS_PATH,
    TMD_EVAL_OUT: RESULT_PATH,
    TMD_EVAL_STEP_DELAY_MS: String(STEP_DELAY_MS),
    // 验收实例跑完即退，不留在桌面打扰用户（drivers 侧 std::process::exit）
    TMD_EVAL_EXIT: '1',
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
    const detail = ok ? '' : `\n    实际值: ${JSON.stringify(value)}`
    console.log(
      `[tauri-mac-check] ${ok ? 'PASS' : 'FAIL'} ${check.id.padEnd(16)} ${check.label}${detail}`,
    )
  })

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
  rmSync(STEPS_PATH, { force: true })
  rmSync(FIXTURE_PATH, { force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main()
