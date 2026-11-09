/**
 * 自动更新。
 *
 * 双更新源：Gitee（国内默认）+ GitHub（国外备用），Gitee 失败时自动切换
 * GitHub 重试一次。Windows 走 electron-updater 下载并重启安装；macOS 只用
 * electron-updater 做版本检查，安装包由本模块自行下载（Squirrel.Mac 路径
 * 实测不可靠，见 downloadMacInstaller 注释），引导用户手动拖入「应用程序」。
 *
 * 依赖注入（autoUpdater/ipcMain/dialog/shell/app/session 由 main.cjs 传入）
 * 而非顶层 require：本模块可被单测直接 require（与 exporter.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const state = require('./app-state.cjs')

// 注意：Gitee raw 有 CDN 缓存（约 5 分钟）。不在此处用查询参数 ?t=xxx 绕过——
// electron-updater 的 generic provider 会把 url 与 latest.yml 拼接，
// 加查询参数会变成 .../releases/?t=xxx/latest.yml 导致 404，故直接接受缓存延迟。
// 分支名必须是 master：Gitee 仓库默认分支不是 main，写成 main 会 404（元数据也写在
// master 上，见 CI 工作流的 contents API 与 docs/打包发布.md §7.2）。
/** @type {import('builder-util-runtime').GenericServerOptions} */
const GITEE_SOURCE = {
  provider: 'generic',
  url: 'https://gitee.com/chiangyangNPU/tmd/raw/master/releases/',
}
/** @type {import('builder-util-runtime').GithubOptions} */
const GITHUB_SOURCE = {
  provider: 'github',
  owner: 'ChiangyangNPU',
  repo: 'tmd',
}

/**
 * 架构迁移元数据端点（migration.json，与 latest.yml / latest.json 同目录）：
 * Gitee 主源（国内）→ GitHub Release 备用。文件不存在即视为「迁移开关关闭」，
 * 404 属正常状态而非错误。
 */
const MIGRATION_URLS = [
  'https://gitee.com/chiangyangNPU/tmd/raw/master/releases/migration.json',
  'https://github.com/ChiangyangNPU/tmd/releases/latest/download/migration.json',
]

/** 迁移元数据拉取超时（毫秒）：失败静默，绝不阻塞常规更新 */
const MIGRATION_FETCH_TIMEOUT_MS = 4000

/**
 * 版本比较（宽松语义版本）：仅比较主/次/修订三段数字。
 * @param {string} a
 * @param {string} b
 * @returns {number} a>b → 1，相等 0，a<b → -1
 */
function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) =>
    String(v)
      .split('-')[0]
      .split('.')
      .map((/** @type {string} */ n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 是否需要提示架构迁移：目标版本严格高于当前版本。导出供单测。
 * @param {string} currentVersion
 * @param {unknown} info migration.json 解析结果
 * @returns {boolean}
 */
function shouldPromptMigration(currentVersion, info) {
  if (!info || typeof info !== 'object') return false
  const version = /** @type {{ version?: unknown }} */ (info).version
  if (typeof version !== 'string' || !version.trim()) return false
  return compareVersions(version, currentVersion) > 0
}

/**
 * 按平台取迁移下载地址（https/http 白名单，防元数据被篡改指向危险协议）。
 * @param {unknown} info
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function pickMigrationUrl(info, platform) {
  if (!info || typeof info !== 'object') return null
  const downloads = /** @type {{ downloads?: unknown }} */ (info).downloads
  if (!downloads || typeof downloads !== 'object') return null
  const key = platform === 'darwin' ? 'darwin' : 'win32'
  const url = /** @type {Record<string, unknown>} */ (downloads)[key]
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}

/**
 * 创建自动更新服务。
 * @param {{
 *   autoUpdater: import('electron-updater').AppUpdater,
 *   ipcMain: import('electron').IpcMain,
 *   shell: import('electron').Shell,
 *   app: import('electron').App,
 *   getDefaultSession: () => import('electron').Session,
 *   IPC: typeof import('./ipc.cjs'),
 *   sendToRenderer: (channel: string, payload?: unknown) => void,
 *   showMessageBoxSafe: (options: import('electron').MessageBoxOptions) => Promise<import('electron').MessageBoxReturnValue>,
 *   clearRendererRecoveryCopy: () => Promise<void>,
 *   readShellState: () => Record<string, unknown>,
 *   saveShellState: (patch: Record<string, unknown>) => void,
 * }} deps
 */
function createUpdater({
  autoUpdater,
  ipcMain,
  shell,
  app,
  getDefaultSession,
  IPC,
  sendToRenderer,
  showMessageBoxSafe,
  clearRendererRecoveryCopy,
  readShellState,
  saveShellState,
}) {
  // ---------- 更新状态 ----------
  /** @type {'gitee' | 'github'} */
  let currentUpdateSource = 'gitee'
  /** 启动时是否自动检查更新（由渲染层经 updateAutoCheck IPC 同步，默认 false） */
  let autoCheckUpdateEnabled = false
  /** 最近一次更新检查是否来自用户手动触发（菜单）；自动检查置 false */
  let updateCheckManual = false
  /** 最近一次 update-available 的元数据（macOS 手动下载 dmg 时取下载地址用） */
  /** @type {import('electron-updater').UpdateInfo | null} */
  let lastUpdateInfo = null
  /** macOS 已下载并校验通过的 dmg 落盘路径（「打开安装包」用） */
  /** @type {string | null} */
  let downloadedInstallerPath = null
  /** 是否已因出错切换过源（避免 error 事件中无限切换重试） */
  let updateSourceSwitched = false

  /**
   * 设置当前更新源并重置切换标记。
   * @param {'gitee' | 'github'} source
   */
  function setUpdateSource(source) {
    currentUpdateSource = source
    autoUpdater.setFeedURL(source === 'gitee' ? GITEE_SOURCE : GITHUB_SOURCE)
    // 切换源后允许出错时再切换到另一个源
    updateSourceSwitched = false
  }

  /**
   * 请求渲染层保存当前文档并等待结果回报（「保存并重启」的握手）。
   * 不设超时：另存为对话框开多久都得等——超时后重启会把未写完的文档留在半路；
   * 悬挂的代价只是更新不立即安装（autoInstallOnAppQuit 在下次退出时兜底）。
   * 同一时刻至多一个待决保存请求（弹窗本身模态），先清旧监听防叠加。
   * @returns {Promise<boolean>} true=已保存干净（脏标记已清），false=失败/被取消/渲染层无响应
   */
  function requestRendererSave() {
    return new Promise((resolve) => {
      ipcMain.removeAllListeners(IPC.docSaveResult)
      ipcMain.once(IPC.docSaveResult, (_event, ok) => resolve(ok === true))
      sendToRenderer(IPC.docSaveRequest)
    })
  }

  /**
   * 安装已下载的更新——update-downloaded 弹窗与设置面板「立即重启」共用入口。
   * 文档干净：确认后 quitAndInstall（Squirrel 退出时从暂存 zip 原子替换
   * /Applications/TMD.app 并重启，全程无需用户动手）。
   * 有未保存修改：不落入窗口 close 拦截的通用「放弃修改并关闭/取消」确认
   * （语义不对且叠在更新流程上），改为三选——保存并重启 / 放弃修改并重启 /
   * 稍后。「稍后」不退出，由 autoInstallOnAppQuit 在下次退出时自动安装。
   */
  async function installDownloadedUpdate() {
    // 主窗口已不在（渲染层进程随之消失）：无脏数据可言，直接走干净重启
    if (!state.getMainWindow() || !state.isRendererDirty()) {
      const { response } = await showMessageBoxSafe({
        type: 'info',
        title: 'TMD',
        message: '下载完成，重启以安装',
        detail: '应用将关闭并安装更新后重新启动。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) autoUpdater.quitAndInstall()
      return
    }
    try {
      const { response } = await showMessageBoxSafe({
        type: 'warning',
        title: 'TMD',
        message: '下载完成，重启以安装',
        detail: '有未保存的修改，重启前需要先处理。',
        // 默认落在「保存并重启」：数据安全优先
        buttons: ['保存并重启', '放弃修改并重启', '稍后'],
        defaultId: 0,
        cancelId: 2,
      })
      if (response === 2) return
      if (response === 1) {
        // 放弃修改并重启：与关闭确认的「放弃修改并关闭」同语义——先清恢复副本，
        // 再销毁窗口绕过 beforeunload 的挂起序列化回写，防止被放弃的内容
        // 以恢复副本"复活"；窗口没了之后再走更新重启（Squirrel 不依赖窗口）
        state.setRendererDirty(false)
        await clearRendererRecoveryCopy()
        state.getMainWindow()?.destroy()
        autoUpdater.quitAndInstall()
        return
      }
      // 保存并重启：saveDocument 成功后渲染层会先同步 setDirty(false)
      // 再回报结果，quitAndInstall 走 close 拦截时 rendererDirty 已是 false
      const saved = await requestRendererSave()
      if (saved) {
        autoUpdater.quitAndInstall()
        return
      }
      // 保存失败/被另存为取消（渲染层已 toast 过失败原因）：留在应用内由用户处理
      showMessageBoxSafe({
        type: 'info',
        title: 'TMD',
        message: '暂不重启',
        detail: '文档未能保存，应用没有重启。已下载的更新会在下次退出时自动安装。',
        buttons: ['确定'],
        defaultId: 0,
      }).catch(() => {})
    } catch (err) {
      // 对话框本身失败（极少见）：停在原地，更新留给下次退出自动安装
      console.warn('[tmd] 更新重启流程中断', err)
    }
  }

  // ---------- macOS：自行下载 dmg + 引导手动安装 ----------
  // 为什么不走 autoUpdater.downloadUpdate()：那条路的安装环节交给 Squirrel.Mac，
  // 实测在 macOS 26 + electron-updater 6.8.9 下两轮复现失败——electron-updater
  // 下载完成后经本地代理把包交给 Squirrel，Squirrel 侧却始终零连接、ShipIt 暂存
  // 目录为空、无任何错误上报，「立即重启」也只是静默挂号，更新永远装不上。故
  // macOS 只用 electron-updater 做版本检查，安装包由这里自行下载，引导用户手动
  // 拖入「应用程序」。

  /**
   * 校验安装包 sha512 与元数据一致。
   * electron-updater 的 downloadUpdate 本会校验元数据里的 sha512，自行下载必须
   * 补上——否则传输截断或被篡改时无从察觉。
   * @param {string} filePath
   * @param {string | undefined} expectedBase64 元数据里的 sha512；缺省时跳过（老格式兜底）
   * @returns {Promise<void>}
   */
  async function verifySha512(filePath, expectedBase64) {
    if (!expectedBase64) return
    const hash = createHash('sha512')
    // 流式读盘而非一次性读入：安装包 ~85MB，避免把整包塞进主进程堆
    /** @type {Promise<void>} */
    const digested = new Promise((resolve, reject) => {
      const stream = fsSync.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    await digested
    if (hash.digest('base64') !== expectedBase64) {
      await fs.unlink(filePath).catch(() => {})
      throw new Error('安装包校验失败（sha512 不匹配），文件已删除，请重试')
    }
  }

  /**
   * 清除下载隔离标记（com.apple.quarantine）。
   * Chromium 的下载栈会给落盘文件打上该标记，用户拖进「应用程序」的 app 会
   * 继承它；本项目为 ad-hoc 签名（build.mac.identity = "-"，不使用开发者证书、
   * 裁剪语言包后与实际内容不符），会被判「已损坏，无法打开」。dmg 由我们自己
   * 下载、且已通过 sha512 校验（来源可信），故主动清除标记，让用户装完直接
   * 双击即可使用。
   *
   * 文件本就没有该标记时 xattr 会返回非零，属正常情况，静默忽略。
   * @param {string} filePath
   * @returns {Promise<void>}
   */
  function clearQuarantine(filePath) {
    return new Promise((resolve) => {
      execFile('xattr', ['-d', 'com.apple.quarantine', filePath], () => resolve())
    })
  }

  /**
   * 下载 URL 到指定目录，返回落盘绝对路径。
   * 走 session.downloadURL + will-download，复用 Electron 自身的下载栈
   * （自动处理重定向），并借 updated 事件回推进度。
   * @param {string} url
   * @param {string} destDir
   * @returns {Promise<string>}
   */
  function downloadToFile(url, destDir) {
    return new Promise((resolve, reject) => {
      const ses = state.getMainWindow()?.webContents.session ?? getDefaultSession()
      let started = false
      const timer = setTimeout(() => {
        if (started) return
        ses.removeListener('will-download', onWillDownload)
        reject(new Error('下载未启动（10 秒内未收到下载响应）'))
      }, 10000)

      // 目标文件名：Gitee 附件地址会 302，最终地址不带原路径，按文件名兜底匹配
      const expectName = new URL(url).pathname.split('/').pop()

      /**
       * @param {import('electron').Event} _event
       * @param {import('electron').DownloadItem} item
       */
      function onWillDownload(_event, item) {
        // 只认本次发起的下载（同一会话同一时刻可能还有其他下载在进行）。
        // Gitee 附件地址会 302 到带令牌的最终地址（foruda.gitee.com/...?token=...），
        // will-download 时 item.getURL() 已是最终地址、与发起 URL 不再相等
        // （发起地址保留在 getURLChain 里）——实测 v0.1.3 发布当日即因严格相等
        // 匹配失败而误报「下载未启动」。匹配口径放宽：URL 或重定向链上任一
        // 与发起一致，或文件名与目标一致
        const chain = item.getURLChain ? item.getURLChain() : []
        if (item.getURL() !== url && !chain.includes(url) && item.getFilename() !== expectName)
          return
        started = true
        clearTimeout(timer)
        ses.removeListener('will-download', onWillDownload)
        const dest = path.join(destDir, item.getFilename())
        item.setSavePath(dest)
        item.on('updated', (_e, itemState) => {
          if (itemState !== 'progressing') return
          const total = item.getTotalBytes()
          sendToRenderer(IPC.updateStatus, {
            status: 'downloading',
            percent: total > 0 ? (item.getReceivedBytes() / total) * 100 : 0,
          })
        })
        item.once('done', (_e, doneState) => {
          if (doneState === 'completed') resolve(dest)
          else reject(new Error(`下载未完成（${doneState}）`))
        })
      }

      ses.on('will-download', onWillDownload)
      ses.downloadURL(url)
    })
  }

  /**
   * macOS 更新安装包下载：把 dmg 下到用户的下载目录并引导手动安装。
   * 依次做 sha512 校验（防截断/篡改）与清除下载隔离标记（防 Gatekeeper 判
   * 「已损坏」），完成后弹窗引导「关闭应用并打开安装包」。
   * @param {import('electron-updater').UpdateInfo} info
   */
  async function downloadMacInstaller(info) {
    try {
      const file = (info.files || []).find((f) => /\.dmg$/i.test(f.url || ''))
      if (!file) throw new Error('更新元数据里没有 dmg 条目')
      const dest = await downloadToFile(file.url, app.getPath('downloads'))
      await verifySha512(dest, file.sha512)
      // 去掉下载隔离标记：否则用户拖进「应用程序」的 app 会被 Gatekeeper 拦下
      await clearQuarantine(dest)
      downloadedInstallerPath = dest
      sendToRenderer(IPC.updateStatus, { status: 'downloaded', path: dest })
      const { response } = await showMessageBoxSafe({
        type: 'info',
        title: 'TMD',
        message: '安装包已下载',
        detail: `${dest}\n\n点击「关闭应用并打开安装包」会退出应用并弹出安装窗口，把 TMD 拖入「应用程序」即可完成安装。`,
        buttons: ['关闭应用并打开安装包', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) void openDownloadedInstallerAndQuit()
    } catch (err) {
      sendToRenderer(IPC.updateStatus, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 打开已下载的 dmg 并退出应用（下载完成弹窗与设置面板「打开安装包」共用）。
   * 有未保存修改时先三选处置（保存 / 放弃 / 取消）。顺序上先 openPath 挂载
   * dmg 再退出应用：安装窗口由 Finder 接管，应用退出后依然显示，避免
   * 「点了之后应用关了却什么都没发生」的空窗。
   * @returns {Promise<void>}
   */
  async function openDownloadedInstallerAndQuit() {
    if (!downloadedInstallerPath) return
    const mainWindow = state.getMainWindow()
    try {
      if (state.isRendererDirty() && mainWindow) {
        const { response } = await showMessageBoxSafe({
          type: 'warning',
          title: 'TMD',
          message: '准备安装更新',
          detail: '有未保存的修改，关闭应用前需要先处理。',
          buttons: ['保存并继续安装', '放弃修改并继续安装', '取消'],
          // 默认落在「保存并继续安装」：数据安全优先
          defaultId: 0,
          cancelId: 2,
        })
        if (response === 2) return
        if (response === 1) {
          // 与关闭确认的「放弃修改并关闭」同语义：清恢复副本，防止被放弃的
          // 内容以恢复副本"复活"
          state.setRendererDirty(false)
          await clearRendererRecoveryCopy()
        } else {
          const saved = await requestRendererSave()
          if (!saved) {
            // 保存失败/被另存为取消（渲染层已 toast 过失败原因）：留在应用内
            showMessageBoxSafe({
              type: 'info',
              title: 'TMD',
              message: '暂不安装',
              detail: '文档未能保存，应用没有关闭。稍后可在设置面板重新打开安装包。',
              buttons: ['确定'],
              defaultId: 0,
            }).catch(() => {})
            return
          }
        }
      }
      const openErr = await shell.openPath(downloadedInstallerPath)
      if (openErr) {
        // 失败时给出明确提示并留在应用内，避免用户点了没反应
        await showMessageBoxSafe({
          type: 'warning',
          title: 'TMD',
          message: '无法打开安装包',
          detail: `${openErr}\n\n请手动到「下载」目录打开该文件。`,
          buttons: ['确定'],
        })
        return
      }
      app.quit()
    } catch (err) {
      console.warn('[tmd] 打开安装包流程中断', err)
    }
  }

  /**
   * 装配自动更新：监听 electron-updater 事件，经 IPC 推送状态给渲染层。
   * 发现新版本后用原生 dialog 询问用户，不静默下载。
   * macOS 为 ad-hoc 签名构建（package.json 的 build.mac.identity = "-"，不使用
   * 开发者证书）；ad-hoc 已能满足 Squirrel.Mac 的签名校验，此处不再额外强制校验。
   */
  function setup() {
    // 不自动下载：发现新版本后弹窗问用户
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // 初始源：Gitee（国内）
    setUpdateSource('gitee')

    autoUpdater.on('checking-for-update', () => {
      sendToRenderer(IPC.updateStatus, { status: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      sendToRenderer(IPC.updateStatus, {
        status: 'available',
        version: info.version,
      })
      lastUpdateInfo = info
      const isMac = process.platform === 'darwin'
      /** @type {import('electron').MessageBoxOptions} */
      const boxOptions = {
        type: 'info',
        title: 'TMD',
        message: `发现新版本 ${info.version}`,
        detail: isMac
          ? '是否下载安装包？下载后需手动打开并拖入「应用程序」完成安装。'
          : '是否立即下载更新？',
        buttons: isMac ? ['下载安装包', '稍后'] : ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }
      // 主窗口可能已关闭（自动更新是应用级事件）：无窗口时以无父窗模式弹出
      showMessageBoxSafe(boxOptions).then(({ response }) => {
        if (response === 0) {
          if (isMac) {
            // 不走 autoUpdater.downloadUpdate()：macOS 交给 Squirrel.Mac 的
            // 路径实测不可靠（见 downloadMacInstaller 处注释），改为自行
            // 下载 dmg 引导手动安装
            void downloadMacInstaller(info)
          } else {
            autoUpdater.downloadUpdate().catch((err) => {
              sendToRenderer(IPC.updateStatus, {
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
              })
            })
          }
        } else {
          sendToRenderer(IPC.updateStatus, { status: 'idle' })
        }
      })
    })

    autoUpdater.on('update-not-available', () => {
      sendToRenderer(IPC.updateStatus, { status: 'not-available' })
      // 仅手动检查（菜单）时弹窗告知「已最新」；启动时的自动检查静默——
      // 否则开启「启动时检查更新」的用户每次启动都被弹窗打扰
      if (updateCheckManual) {
        showMessageBoxSafe({
          type: 'info',
          title: 'TMD',
          message: '当前已是最新版本',
          buttons: ['确定'],
        })
      }
    })

    autoUpdater.on('download-progress', (progress) => {
      sendToRenderer(IPC.updateStatus, {
        status: 'downloading',
        percent: progress.percent,
      })
    })

    autoUpdater.on('update-downloaded', () => {
      sendToRenderer(IPC.updateStatus, { status: 'downloaded' })
      void installDownloadedUpdate()
    })

    autoUpdater.on('error', (err) => {
      // 当前源为 Gitee 且尚未因出错切换过：切换到 GitHub 重试一次
      if (currentUpdateSource === 'gitee' && !updateSourceSwitched) {
        updateSourceSwitched = true
        currentUpdateSource = 'github'
        autoUpdater.setFeedURL(GITHUB_SOURCE)
        autoUpdater.checkForUpdates().catch(() => {
          // 切换后仍失败：error 事件会再次触发，此时 currentUpdateSource === 'github'
          // 落到下面的 error 状态推送
        })
        return
      }
      sendToRenderer(IPC.updateStatus, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** 注册 updateCheck / updateDownload / updateInstall / updateAutoCheck 四条 IPC */
  function registerIpc() {
    // 手动检查更新：重置源为 Gitee，并标记来源——「已是最新版本」的弹窗只对
    // 手动检查生效（自动检查静默，见 update-not-available 处理器）
    ipcMain.handle(IPC.updateCheck, async () => {
      updateCheckManual = true
      setUpdateSource('gitee')
      // 架构迁移优先：命中即引导下载新架构安装包，不再走本架构更新检查
      // （自动检查不提示迁移——避免启动时被架构切换弹窗打扰）
      try {
        if (await maybePromptMigration()) return
      } catch {
        // 迁移判定异常不影响常规更新
      }
      try {
        await autoUpdater.checkForUpdates()
      } catch (err) {
        sendToRenderer(IPC.updateStatus, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // 用户同意下载
    ipcMain.handle(IPC.updateDownload, async (event) => {
      state.assertMainWindow(event)
      try {
        // macOS 不走 electron-updater 下载（Squirrel 路径不可靠，见
        // downloadMacInstaller 注释）：从最近一次 update-available 的元数据
        // 自行下载 dmg
        if (process.platform === 'darwin') {
          if (lastUpdateInfo) await downloadMacInstaller(lastUpdateInfo)
          return
        }
        await autoUpdater.downloadUpdate()
      } catch (err) {
        sendToRenderer(IPC.updateStatus, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // 安装已下载的更新：macOS 打开 dmg 引导手动安装并退出应用；
    // Windows 走 electron-updater 重启安装（有未保存修改时先三选处置）
    ipcMain.handle(IPC.updateInstall, (event) => {
      state.assertMainWindow(event)
      if (process.platform === 'darwin') {
        void openDownloadedInstallerAndQuit()
      } else {
        void installDownloadedUpdate()
      }
    })

    // 渲染层同步"启动时自动检查更新"开关
    /** @param {unknown} _event @param {unknown} enabled */
    ipcMain.on(IPC.updateAutoCheck, (_event, enabled) => {
      autoCheckUpdateEnabled = !!enabled
    })
  }

  /**
   * 拉取迁移元数据：Gitee 主源 → GitHub 备用，超时 4 秒，任何失败静默
   * 返回 null（文件不存在 = 迁移开关关闭，属正常状态）。
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function fetchMigrationInfo() {
    for (const url of MIGRATION_URLS) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), MIGRATION_FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
        if (!res.ok) continue
        const data = await res.json()
        if (data && typeof data === 'object' && typeof data.version === 'string') {
          return data
        }
      } catch {
        // 网络/超时/解析失败：换下一个源；全部失败即视为不可用
      } finally {
        clearTimeout(timer)
      }
    }
    return null
  }

  /**
   * 手动检查更新时优先判定架构迁移：目标版本高于当前且尚未提示过该版本
   * → 原生对话框引导前往下载 Rust 版（跨架构无法自动升级，需手动装一次；
   * 文档与配置全保留）。同一目标版本只提示一次，选择「稍后」不再反复打扰。
   *
   * @returns {Promise<boolean>} true = 已接手本次检查（调用方跳过常规更新）
   */
  async function maybePromptMigration() {
    const info = await fetchMigrationInfo()
    if (!shouldPromptMigration(app.getVersion(), info)) return false
    const url = pickMigrationUrl(info, process.platform)
    if (!url) return false
    const version = String(/** @type {{version: string}} */ (info).version)
    if (readShellState().migrationPrompted === version) return false

    const notes = /** @type {{notes?: unknown}} */ (info).notes
    const { response } = await showMessageBoxSafe({
      type: 'info',
      title: 'TMD',
      message: `TMD ${version} 已发布（全新 Rust 架构）`,
      detail:
        typeof notes === 'string' && notes.trim()
          ? notes
          : '新架构安装包体积约 6MB（原约 290MB），启动更快、空闲内存更省。' +
            '跨架构无法自动升级，需手动下载安装一次；文档、历史版本、AI 配置等全部保留。',
      buttons: ['前往下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    // 用户已看到提示：记录目标版本（无论选了下载还是稍后），后续检查不再重复
    saveShellState({ migrationPrompted: version })
    if (response === 0) {
      await shell.openExternal(url).catch(() => {})
    }
    sendToRenderer(IPC.updateStatus, { status: 'idle' })
    return true
  }

  /**
   * 启动后 5 秒自动检查更新：仅当渲染层已同步开关为 true。
   * 渲染层 boot 时（wireSettings 内）会把 localStorage 的开关值发给主进程，
   * 该 IPC 通常在数毫秒内到达，远早于 5 秒延时。
   */
  function scheduleAutoCheck() {
    setTimeout(() => {
      if (autoCheckUpdateEnabled) {
        updateCheckManual = false
        setUpdateSource('gitee')
        autoUpdater.checkForUpdates().catch((err) => {
          sendToRenderer(IPC.updateStatus, {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }, 5000)
  }

  return { setup, registerIpc, scheduleAutoCheck }
}

module.exports = { createUpdater, compareVersions, shouldPromptMigration, pickMigrationUrl }
