/**
 * 文件与目录 IPC（主进程侧）。
 *
 * 覆盖：打开/读取/保存文件、目录列举、跨文件全文搜索、双链扫描、文件式主题、
 * 日志上报、侧边栏文件管理（新建/重命名/显示）、本地历史版本、通用导出与
 * PDF 打印。渲染层保持纯网页逻辑，所有 Node 能力经 preload 暴露的受控 API 访问。
 *
 * 依赖注入（ipcMain/shell/app/对话框辅助/fileWatcher/logger 由 main.cjs 传入）
 * 而非顶层 require('electron')：本模块可被单测直接 require（与 exporter.cjs 同构）。
 * search/wikilinks/themes/fsops/history/logger 为纯 Node 模块，直接 require。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const {
  collectSearchFiles,
  searchInFiles,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES,
} = require('./search.cjs')
const { scanWikiLinks } = require('./wikilinks.cjs')
const {
  themesDir,
  migrateLegacyThemes,
  listThemeFiles,
  readThemeFile,
  ensureThemesDirWithSample,
} = require('./themes.cjs')
const { sanitizeFileName, childPath, ensureMarkdownExt } = require('./fsops.cjs')
const { historyDir, writeSnapshot, listSnapshots, readSnapshot } = require('./history.cjs')
const { tmdHome, logsDir, normalizeRendererReport } = require('./logger.cjs')
const state = require('./app-state.cjs')

/** @type {import('electron').FileFilter[]} */
const MD_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
/** 打开对话框另放行 .txt（保存对话框仍只用 MD_FILTERS，新建/另存为默认产出 .md） */
const OPEN_FILTERS = [{ name: 'Markdown / 文本文档', extensions: ['md', 'markdown', 'txt'] }]

/** 单文件读取上限（50MB）：Markdown 文档实际场景很少超过几 MB，
 *  更大的多为日志/数据 dump——直接读入会让主进程 OOM 或长时间无响应 */
const MAX_READ_FILE_BYTES = 50 * 1024 * 1024

/**
 * 注册文件与目录相关的全部 IPC。
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   shell: import('electron').Shell,
 *   app: import('electron').App,
 *   IPC: typeof import('./ipc.cjs'),
 *   fileWatcher: ReturnType<typeof import('./filewatcher.cjs').createFileWatcher>,
 *   logger: ReturnType<typeof import('./logger.cjs').createLogger>,
 *   showOpenDialogSafe: (options: import('electron').OpenDialogOptions) => Promise<import('electron').OpenDialogReturnValue>,
 *   showSaveDialogSafe: (options: import('electron').SaveDialogOptions) => Promise<import('electron').SaveDialogReturnValue>,
 * }} deps
 */
function registerFileIpc({
  ipcMain,
  shell,
  app,
  IPC,
  fileWatcher,
  logger,
  showOpenDialogSafe,
  showSaveDialogSafe,
}) {
  // 资产根目录（TMD_HOME_DIR 可重定位）：history/logs/themes 均随它走
  const tmdRoot = tmdHome()
  // 本地历史版本根目录：每次写盘覆盖前把被覆盖的旧内容存档，仅提供人工恢复
  // 入口（不自动回滚）。与 themes / logs 同级、跨升级保留
  const historyRoot = historyDir(tmdRoot)

  // 旧版本主题目录（<tmdRoot>/themes）迁移：主题 IPC 首次访问时执行一次。
  // 失败也缓存结果，避免每次主题操作重复扫描；迁移失败不影响读写新目录。
  let legacyThemesMigration = null
  function ensureLegacyThemesMigrated() {
    legacyThemesMigration ??= migrateLegacyThemes(tmdRoot).catch(() => 0)
    return legacyThemesMigration
  }

  /**
   * 读取文本文件并做大小上限校验（openFile/readFile 共用）。
   * 先用 fs.stat 预检而非读入后再截断：避免大文件撑爆主进程内存。
   * @param {string} filePath
   * @returns {Promise<string>} UTF-8 文本内容
   * @throws {Error} 文件超过 MAX_READ_FILE_BYTES 时抛出，消息含实际大小与上限
   */
  async function readFileCapped(filePath) {
    const stat = await fs.stat(filePath)
    // 目录 / FIFO / 字符设备的 size 可能为 0（如 /dev/zero），只看 size 会让
    // fs.readFile 持续读入或阻塞，反而绕过上限——先要求是普通文件
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size > MAX_READ_FILE_BYTES) {
      const actualMB = (stat.size / 1024 / 1024).toFixed(1)
      const limitMB = Math.round(MAX_READ_FILE_BYTES / 1024 / 1024)
      throw new Error(`file too large: ${actualMB} MB (limit ${limitMB} MB)`)
    }
    return fs.readFile(filePath, 'utf-8')
  }

  /**
   * 写盘前的历史快照：读取即将被覆盖的旧内容存入历史目录。
   * 快照是纯附加能力，任何失败（文件首次创建、权限、磁盘）都必须静默，
   * 绝不能反过来阻断用户的保存动作；去重与剪枝由 history.cjs 内部处理。
   * @param {string} filePath
   */
  async function snapshotBeforeWrite(filePath) {
    try {
      // 走 readFileCapped：>50MB 文件直接抛错被外层 catch 吞掉（不写快照但仍允许保存）。
      // 若此处直接 fs.readFile，攻击者可通过 saveFile 传入任意大文件路径绕过
      // openFile/readFile 通道的 50MB 上限，导致主进程 OOM。
      const previous = await readFileCapped(filePath)
      await writeSnapshot(historyRoot, {
        path: filePath,
        name: path.basename(filePath),
        content: previous,
      })
    } catch {
      /* 文件尚不存在（首次保存）或读取失败或超过 50MB 上限：无旧内容可存 */
    }
  }

  ipcMain.handle(IPC.openFile, async () => {
    const result = await showOpenDialogSafe({
      filters: OPEN_FILTERS,
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]
    const content = await readFileCapped(filePath)
    return { path: filePath, name: path.basename(filePath), content }
  })

  /** @param {unknown} _event @param {string} filePath */
  ipcMain.handle(IPC.readFile, async (_event, filePath) => {
    // IPC 入参不可信：非字符串/空路径直接拒绝，避免 fs 错误直穿渲染层
    if (typeof filePath !== 'string' || !filePath) throw new Error('invalid path')
    const content = await readFileCapped(filePath)
    return { path: filePath, name: path.basename(filePath), content }
  })

  // 列出文件夹内一层 Markdown 文件与子文件夹，用于文件树侧边栏。
  // 子文件夹统一返回空 children 占位：是否继续读取由渲染层在用户展开时懒加载，
  // 避免打开超大目录时一次性递归整棵树（任意层级均可逐层展开，没有深度上限）。
  /** @param {unknown} _event @param {string} dirPath */
  ipcMain.handle(IPC.readDir, async (_event, dirPath) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      /** @type {import('../src/filetree.ts').FileEntry[]} */
      const folders = []
      /** @type {import('../src/filetree.ts').FileEntry[]} */
      const files = []
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name, state.getSortLocale() || app.getLocale()),
      )) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          // 空数组 = 「是目录但子项未加载」，渲染层首次展开时再按路径发 readDir
          folders.push({ name: entry.name, path: full, children: [] })
        } else if (/\.(md|markdown|txt)$/i.test(entry.name)) {
          files.push({ name: entry.name, path: full })
        }
      }
      return { path: dirPath, name: path.basename(dirPath), children: [...folders, ...files] }
    } catch {
      return null
    }
  })

  // ---------- 跨文件全文搜索 ----------

  /** @param {unknown} _event @param {unknown} roots @param {unknown} query */
  ipcMain.handle(IPC.searchFiles, async (_event, roots, query) => {
    /** @type {import('../src/native.ts').SearchResult} */
    const empty = { matches: [], fileCount: 0, scannedFiles: 0, truncated: false, elapsedMs: 0 }
    if (!Array.isArray(roots) || typeof query !== 'string') return empty
    const needle = query.trim().toLowerCase()
    const dirs = roots.filter((r) => typeof r === 'string' && r !== '')
    if (!needle || !dirs.length) return empty

    const started = Date.now()
    const collected = await collectSearchFiles(dirs, SEARCH_MAX_FILES)
    const searched = await searchInFiles(collected.files, needle, SEARCH_MAX_MATCHES)
    return {
      matches: searched.matches,
      fileCount: searched.fileCount,
      scannedFiles: collected.files.length,
      truncated: collected.truncated || searched.truncated,
      elapsedMs: Date.now() - started,
    }
  })

  // ---------- 双链索引 ----------

  /** @param {unknown} _event @param {unknown} roots */
  ipcMain.handle(IPC.wikiScan, async (_event, roots) => {
    /** @type {import('../src/native.ts').WikiScanResult} */
    const empty = { notes: [], links: [], truncated: false }
    if (!Array.isArray(roots)) return empty
    const dirs = roots.filter((r) => typeof r === 'string' && r !== '')
    if (!dirs.length) return empty
    try {
      return await scanWikiLinks(dirs, SEARCH_MAX_FILES)
    } catch (err) {
      // 扫描异常不中断应用：按空结果上报（面板/图谱呈现为空态）
      console.error('[tmd] 双链扫描失败', err)
      return empty
    }
  })

  // ---------- 文件式主题（~/.tmd/themes/*.css） ----------
  // 主题目录统一经 themesDir(tmdRoot) 计算：默认 ~/.tmd/themes，随 TMD_HOME_DIR
  // 整体重定位时必须仍落在 <tmdRoot>/.tmd/ 下（与 logs/history/crash-dumps 同级）。
  // 不要手写 path.join(tmdRoot, 'themes')——曾因此漏掉 .tmd 段，主题被读写到
  // 用户主目录根的 ~/themes（2026-09-30 引入，2026-10-17 修复，单测见
  // src/__tests__/ipc-files.test.ts）

  /** 列出主题目录中的全部主题文件 + 目录绝对路径（目录不存在返回空列表） */
  ipcMain.handle(IPC.themesList, async () => {
    await ensureLegacyThemesMigrated()
    const dir = themesDir(tmdRoot)
    const themes = await listThemeFiles(dir, state.getSortLocale() || app.getLocale())
    return { dir, themes }
  })

  /** 读取单个主题文件内容（裸文件名经主进程 basename 校验，失败返回 null） */
  /** @param {unknown} _event @param {unknown} name */
  ipcMain.handle(IPC.themesRead, async (_event, name) => {
    await ensureLegacyThemesMigrated()
    const dir = themesDir(tmdRoot)
    return readThemeFile(dir, name)
  })

  /** 在系统文件管理器中打开主题目录：不存在则创建，并在空目录写入示例主题 */
  ipcMain.handle(IPC.themesOpenDir, async () => {
    await ensureLegacyThemesMigrated()
    const dir = themesDir(tmdRoot)
    try {
      await ensureThemesDirWithSample(dir)
      const error = await shell.openPath(dir)
      return !error
    } catch (err) {
      console.error('[tmd] 打开主题目录失败', err)
      return false
    }
  })

  // ---------- 日志与诊断（零遥传，仅本地落盘） ----------

  /**
   * 渲染层错误上报（window.onerror / unhandledrejection 经 preload 桥接）。
   * 与主进程日志同文件落盘，level 固定 error。
   * @param {unknown} _event
   * @param {unknown} payload
   */
  ipcMain.on(IPC.logReport, (_event, payload) => {
    const entry = normalizeRendererReport(payload)
    if (!entry) return
    logger.log('error', 'renderer', entry.message, entry.stack, {
      filename: entry.filename,
      lineno: entry.lineno,
      colno: entry.colno,
    })
  })

  /** 在系统文件管理器中打开日志目录：不存在则创建（空目录即可，不写示例文件） */
  ipcMain.handle(IPC.logOpenDir, async () => {
    try {
      const dir = logsDir(tmdRoot)
      await fs.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      return !error
    } catch (err) {
      console.warn('[tmd] 打开日志目录失败', err)
      return false
    }
  })

  // ---------- 保存与另存为 ----------

  /** @param {unknown} event @param {string} filePath @param {string} content */
  ipcMain.handle(IPC.saveFile, async (event, filePath, content) => {
    state.assertMainWindow(event)
    if (typeof filePath !== 'string' || !filePath) throw new Error('invalid path')
    if (typeof content !== 'string') throw new Error('invalid content')
    await snapshotBeforeWrite(filePath)
    await fs.writeFile(filePath, content, 'utf-8')
    // 写盘成功后更新监视指纹：本次写入不再触发「外部修改」误报
    fileWatcher.noteWrite(filePath, content)
    return true
  })

  /** @param {unknown} event @param {string} content @param {string} defaultName */
  ipcMain.handle(IPC.saveFileAs, async (event, content, defaultName) => {
    state.assertMainWindow(event)
    if (typeof content !== 'string') throw new Error('invalid content')
    const result = await showSaveDialogSafe({
      defaultPath: typeof defaultName === 'string' ? defaultName : undefined,
      filters: MD_FILTERS,
    })
    if (result.canceled || !result.filePath) return null
    await snapshotBeforeWrite(result.filePath)
    await fs.writeFile(result.filePath, content, 'utf-8')
    fileWatcher.noteWrite(result.filePath, content)
    return { path: result.filePath, name: path.basename(result.filePath) }
  })

  /** 渲染层全量同步「已打开文件路径集合」，主进程差量挂/卸 fs.watch */
  /** @param {unknown} _event @param {unknown} paths */
  ipcMain.handle(IPC.watchFiles, (_event, paths) => {
    if (!Array.isArray(paths)) return
    fileWatcher.sync(paths.filter((p) => typeof p === 'string' && p !== ''))
  })

  // ---------- 侧边栏文件管理（新建 / 重命名 / 在系统中显示） ----------
  // 名称经 fsops.cjs 清洗 + 路径二次校验；已存在时抛错（wx / recursive:false），
  // 渲染层捕获后 toast，不覆盖任何现有文件。

  /** @param {unknown} event @param {string} dirPath @param {unknown} name */
  ipcMain.handle(IPC.createFile, async (event, dirPath, name) => {
    state.assertMainWindow(event)
    const safe = sanitizeFileName(name)
    const target = childPath(dirPath, ensureMarkdownExt(safe ?? ''))
    if (!target) throw new Error('invalid file name')
    await fs.writeFile(target, '', { flag: 'wx' })
    return { path: target, name: path.basename(target) }
  })

  /** @param {unknown} event @param {string} dirPath @param {unknown} name */
  ipcMain.handle(IPC.createDir, async (event, dirPath, name) => {
    state.assertMainWindow(event)
    const target = childPath(dirPath, name)
    if (!target) throw new Error('invalid folder name')
    await fs.mkdir(target, { recursive: false })
    return { path: target, name: path.basename(target) }
  })

  /** @param {unknown} event @param {string} oldPath @param {unknown} name */
  ipcMain.handle(IPC.renamePath, async (event, oldPath, name) => {
    state.assertMainWindow(event)
    if (typeof oldPath !== 'string' || !oldPath) throw new Error('invalid path')
    const target = childPath(path.dirname(oldPath), name)
    if (!target || target === oldPath) throw new Error('invalid rename target')
    await fs.rename(oldPath, target)
    return { path: target, name: path.basename(target) }
  })

  /** @param {unknown} event @param {unknown} targetPath */
  ipcMain.handle(IPC.revealInFolder, (event, targetPath) => {
    state.assertMainWindow(event)
    if (typeof targetPath !== 'string' || !targetPath) return false
    shell.showItemInFolder(targetPath)
    return true
  })

  // ---------- 本地历史版本 ----------

  /** 列出某文件的快照清单（最新在前），无历史返回 null */
  ipcMain.handle(IPC.historyList, async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null
    return listSnapshots(historyRoot, filePath)
  })

  /** 读取单条快照正文（id 合法性由 history.cjs 校验，防目录穿越） */
  ipcMain.handle(IPC.historyRead, async (_event, filePath, id) => {
    if (typeof filePath !== 'string' || !filePath) return null
    return readSnapshot(historyRoot, filePath, id)
  })

  // ---------- 导出与打印 ----------

  // 通用导出（HTML 等）：弹出另存为对话框并写入
  /**
   * @param {unknown} event
   * @param {{ content: string, defaultName: string, filters: { name: string, extensions: string[] }[] }} options
   */
  ipcMain.handle(IPC.exportAs, async (event, options) => {
    state.assertMainWindow(event)
    // IPC 入参不可信：缺 content 直接取消，其余字段做类型收敛后再交给对话框
    if (!options || typeof options.content !== 'string') return null
    const { content, defaultName, filters } = options
    const result = await showSaveDialogSafe({
      defaultPath: typeof defaultName === 'string' ? defaultName : undefined,
      filters: Array.isArray(filters) ? filters : undefined,
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, content, 'utf-8')
    return { path: result.filePath, name: path.basename(result.filePath) }
  })

  // 导出 PDF：printToPDF 程序化生成（跟随 @media print 样式与 @page 页边距）
  // + 保存对话框落盘。不走 webContents.print 的系统打印对话框——Electron 44
  // 在 macOS 上该对话框会静默失败（点击无反应），且「选存储为 PDF」的间接
  // 路径体验也差于直接出文件。
  ipcMain.handle(IPC.print, async (_event, name) => {
    const win = state.getMainWindow()
    if (!win || win.isDestroyed()) return false
    try {
      const data = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true, // 打印样式里的 @page 18mm 页边距生效
        pageSize: 'A4',
      })
      const raw = typeof name === 'string' && name.trim() ? name.trim() : '导出'
      // 笔记名自带 .md 扩展名,落盘为 PDF 时剥掉(否则得到 笔记A.md.pdf)
      const base = raw.replace(/\.(md|markdown)$/i, '').trim() || '导出'
      const safe = base.replace(/[\\/:*?"<>|]/g, '_')
      const result = await showSaveDialogSafe({
        title: '导出 PDF',
        defaultPath: `${safe}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (!result || result.canceled || !result.filePath) return false
      await fs.writeFile(result.filePath, data)
      return true
    } catch (err) {
      console.error('[tmd] PDF 导出失败', err)
      return false
    }
  })

  // 选择文件夹（文件树）
  ipcMain.handle(IPC.openFolder, async () => {
    const result = await showOpenDialogSafe({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
}

module.exports = { registerFileIpc }
