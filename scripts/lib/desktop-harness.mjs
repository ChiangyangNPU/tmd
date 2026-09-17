/**
 * 桌面端 E2E 共享驱动（desktop-export-check / desktop-app-check 复用）。
 *
 * 只提供「怎么把应用跑起来、怎么连上调试协议、怎么收尾」的机制，
 * 不含任何具体断言——场景与断理由各检查脚本自行持有。
 *
 * 内容：
 * - Cdp：基于 Node 内置 WebSocket 的极简 CDP 客户端（求值/命令收发）
 * - waitForTarget：轮询调试端口等待指定目标（page / node）
 * - spawnApp：以隔离 user-data-dir + 固定调试端口启动 dist 产物 Electron，
 *   支持注入额外环境变量（如 TMD_HOME_DIR 隔离用户资产目录）
 * - killTree / cleanupElectron：杀整个进程组并清理孤儿（.bin/electron 是包装脚本，
 *   只杀 child 会留下孙进程）
 *
 * @author chiangyang
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 渲染层远程调试端口（同一时刻仅允许一个脚本实例运行） */
export const RENDERER_PORT = 9222
/** 主进程 --inspect 端口 */
export const MAIN_PORT = 9229

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 极简 CDP 客户端（Node 内置 WebSocket） */
export class Cdp {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    /** @type {Map<number, {resolve: (v: unknown) => void, reject: (e: Error) => void}>} */
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = (e) => reject(new Error('ws error: ' + e?.message))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      // 协议错误与正常结果走同一个 id，按 msg.error 分流
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  }

  /**
   * 发送 CDP 命令并等待结果。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<{ result?: unknown, exceptionDetails?: unknown } & Record<string, unknown>>}
   */
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 60000)
    })
  }

  /**
   * 求值并取回 JSON 值（主进程侧用于 stub 对话框与检查产物，渲染层侧用于断言 DOM）。
   * @param {string} expression
   * @returns {Promise<unknown>}
   */
  async evalJson(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error('求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 轮询调试端口，等待匹配条件的目标出现。
 * @param {number} port
 * @param {(target: { type?: string, url?: string, webSocketDebuggerUrl?: string }) => boolean} predicate
 * @param {number} [timeoutMs]
 */
export async function waitForTarget(port, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const hit = list.find(predicate)
      if (hit?.webSocketDebuggerUrl) return hit
    } catch {
      /* 端口未就绪，继续等 */
    }
    await sleep(300)
  }
  throw new Error(`等待调试目标超时（port ${port}）`)
}

/**
 * 探测调试端口是否仍被实例占用（能拿到任何 HTTP 响应即视为占用）。
 * 崩溃实例（process.crash / SIGKILL）退出后端口释放有短暂窗口，
 * 仅靠固定 sleep 不足以保证下一个脚本/实例启动时环境干净。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/list`)
    return true
  } catch {
    return false
  }
}

/**
 * 等待渲染层 / 主进程调试端口全部空闲（拒绝连接），作为启动前的确定性闸门。
 * @param {number} [timeoutMs]
 */
export async function waitForPortsFree(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const busy = await Promise.all([isPortBusy(RENDERER_PORT), isPortBusy(MAIN_PORT)])
    if (!busy.some(Boolean)) return
    if (Date.now() > deadline) throw new Error('调试端口仍被占用，可能有残留实例')
    await sleep(250)
  }
}

/**
 * 以固定调试端口启动 dist 产物的 Electron（隔离配置目录）。
 *
 * 始终消费子进程的 stdout/stderr：不读会让 Electron 写满管道缓冲区后阻塞
 * （崩溃类场景输出尤其多）。默认静默，设 TMD_E2E_VERBOSE=1 时转发到父进程
 * 输出并加 [electron:out|err] 前缀，便于排查崩溃现场。
 *
 * @param {{
 *   repo: string,
 *   profile: string,
 *   extraArgs?: string[],
 *   env?: Record<string, string>,
 * }} options
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
 */
export function spawnApp({ repo, profile, extraArgs = [], env = {} }) {
  const electronBin = join(repo, 'node_modules', '.bin', 'electron')
  if (!existsSync(electronBin)) throw new Error('未找到 electron 可执行文件')
  const child = spawn(
    electronBin,
    [
      '.',
      `--remote-debugging-port=${RENDERER_PORT}`,
      `--inspect=${MAIN_PORT}`,
      `--user-data-dir=${profile}`,
      ...extraArgs,
    ],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached：Electron 由包装脚本派生出孙进程，结束时按进程组整组回收
      detached: true,
      env: { ...process.env, ...env },
    },
  )
  const verbose = process.env.TMD_E2E_VERBOSE === '1'
  /** @param {NodeJS.ReadableStream | null} stream @param {string} tag */
  const relay = (stream, tag) => {
    if (!stream) return
    stream.on('data', (buf) => {
      if (verbose) process.stdout.write(`[electron:${tag}] ${String(buf)}`)
    })
  }
  relay(child.stdout, 'out')
  relay(child.stderr, 'err')
  return child
}

/**
 * 等待应用进程退出。
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
export function waitExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待应用退出超时')), timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

/**
 * 杀掉应用整个进程组（兜底再单独杀 child 本身）。
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}

/** 清理可能残留的孤儿 Electron 进程（每轮启动前调用） */
export function cleanupElectron() {
  spawnSync('pkill', ['-f', 'tmd/node_modules/electron'])
}
