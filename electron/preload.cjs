/**
 * preload：向渲染层暴露类型安全的受控文件 API
 * 渲染层通过 window.tmdAPI 使用，无 Node 权限直接暴露。
 *
 * 暴露对象按 src/native.ts 的 NativeFileAPI 接口标注（tsc checkJs 校验）：
 * 与接口不一致（缺方法、签名不符）会在编译期报错。
 *
 * @author chiangyang
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')
const IPC = require('./ipc.cjs')

// open-path 消息可能早于渲染层注册处理器到达，先缓冲
/** @type {string[]} */
const openPathQueue = []
/** @type {((filePath: string) => void) | null} */
let openPathCallback = null
ipcRenderer.on(IPC.openPath, (_event, filePath) => {
  if (openPathCallback) openPathCallback(filePath)
  else if (filePath) openPathQueue.push(filePath)
})

/** @type {import('../src/native.ts').NativeFileAPI} */
const api = {
  /** 是否在 Electron 环境中（浏览器里为 undefined，渲染层据此降级） */
  isNative: true,
  /** 打开文件对话框并读取所选文件，返回路径与内容 */
  openFile: () => ipcRenderer.invoke(IPC.openFile),
  /** 读取指定路径的文件内容 */
  readFile: (filePath) => ipcRenderer.invoke(IPC.readFile, filePath),
  /** 读取指定目录的内容（文件树） */
  readDir: (dirPath) => ipcRenderer.invoke(IPC.readDir, dirPath),
  /** 选择文件夹（用于侧边栏挂载工作区） */
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  /** 把内容写入指定路径 */
  /** 保存：content 为编辑器序列化文本；meta 携带原文件编码与换行风格 */
  saveFile: (filePath, content, meta) => ipcRenderer.invoke(IPC.saveFile, filePath, content, meta),
  /** 另存为：弹对话框选路径后写入；meta 可选（新文件默认 UTF-8/LF） */
  saveFileAs: (content, defaultName, meta) =>
    ipcRenderer.invoke(IPC.saveFileAs, content, defaultName, meta),
  /** 通用导出：按过滤器弹保存对话框并写入 */
  exportAs: (options) => ipcRenderer.invoke(IPC.exportAs, options),
  /** 离线 HTML 导出资源（主进程缓存；缺失返回 null） */
  getExportAssets: () => ipcRenderer.invoke(IPC.exportAssets),
  /** 调起系统打印（导出 PDF 走此路径） */
  print: (name, options) => ipcRenderer.invoke(IPC.print, name, options),
  /** 向主进程同步未保存状态（用于关闭确认） */
  setDirty: (dirty) => ipcRenderer.send(IPC.setDirty, dirty),
  /** 订阅主进程菜单项动作（参数为 action 标识） */
  onMenu: (callback) => {
    ipcRenderer.on(IPC.menu, (_event, action) => callback(action))
  },
  /** 自动保存开关（菜单 checkbox 切换） */
  onAutosave: (callback) => {
    ipcRenderer.on(IPC.autosave, (_event, enabled) => callback(enabled))
  },
  /** 文件关联：Finder 双击 .md / 系统打开方式传入的文件路径。
   *  消息可能在渲染层注册处理器之前到达（did-finish-load 早于 boot 完成），
   *  故先在 preload 缓冲，注册后再补发。 */
  onOpenPath: (callback) => {
    openPathCallback = callback
    while (openPathQueue.length) {
      const p = openPathQueue.shift()
      if (p) callback(p)
    }
  },
  /** 把当前语言的菜单文案与语言码发给主进程：重建菜单并切换文件树排序区域 */
  setLocaleInfo: (info) => ipcRenderer.send(IPC.setLocaleInfo, info),
  /** 渲染层就绪信号：主进程补发排队中的待打开文件 */
  ready: () => ipcRenderer.send(IPC.ready),
  /** 设置面板同步自动保存开关（保持与菜单勾选一致） */
  setAutosaveEnabled: (enabled) => ipcRenderer.send(IPC.setAutosaveEnabled, enabled),
  /** 粘贴图片落盘：写入文档同目录 assets/ 文件夹 */
  saveImage: (options) => ipcRenderer.invoke(IPC.saveImage, options),
  /** 链接点击：打开外部 http/https 链接（主进程校验协议白名单） */
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  /** 链接点击：用系统默认应用打开本地文件（绝对路径），返回错误串（空串为成功） */
  openLocalFile: (filePath) => ipcRenderer.invoke(IPC.openLocalFile, filePath),
  /** 拖入文件换绝对路径（Electron 32+ 移除了 File.path，用 webUtils 同步解析） */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** 手动触发检查更新（设置面板"检查更新"按钮） */
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  /** 用户同意后触发下载 */
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  /** 安装已下载的更新并重启（有未保存修改时主进程会先三选处置） */
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  /** 「保存并重启」握手：主进程请求保存当前文档（更新重启前的脏文档处置） */
  onSaveRequest: (callback) => {
    ipcRenderer.on(IPC.docSaveRequest, () => callback())
  },
  /** 保存请求处理完毕回报：true=已保存干净（可安全重启），false=失败/被取消 */
  reportSaveResult: (ok) => ipcRenderer.send(IPC.docSaveResult, ok),
  /** 监听主进程推送的更新状态变化 */
  onUpdateStatus: (callback) => {
    ipcRenderer.on(IPC.updateStatus, (_event, status) => callback(status))
  },
  /** 同步"启动时自动检查更新"开关给主进程 */
  setAutoCheckUpdate: (enabled) => ipcRenderer.send(IPC.updateAutoCheck, enabled),
  /** 同步主题给主进程：标题栏/窗口底色切换完成后返回，渲染层再切页面使两者视觉同步 */
  setThemeSource: (isDark) => ipcRenderer.invoke(IPC.setThemeSource, isDark),
  /** 自绘标题栏（Windows/Linux）：最小化窗口 */
  winMinimize: () => ipcRenderer.send(IPC.winMinimize),
  /** 自绘标题栏（Windows/Linux）：最大化/还原切换 */
  winMaximizeToggle: () => ipcRenderer.send(IPC.winMaximizeToggle),
  /** 自绘标题栏（Windows/Linux）：关闭窗口（仍走未保存关闭确认流程） */
  winClose: () => ipcRenderer.send(IPC.winClose),
  /** 订阅窗口最大化状态变化（自绘 □/❐ 图标切换用） */
  onWindowMaximize: (callback) => {
    ipcRenderer.on(IPC.winMaxChanged, (_event, isMax) => callback(isMax))
  },
  /** 启动时全量同步最近文件列表给主进程构建子菜单 */
  recentSync: (entries) => ipcRenderer.send(IPC.recentSync, entries),
  /** 新增/打开文件后注册系统最近文档并置顶主进程菜单 */
  recentAdd: (entry) => ipcRenderer.send(IPC.recentAdd, entry),
  /** 渲染层清空最近列表后通知主进程清空系统最近文档 */
  recentClear: () => ipcRenderer.send(IPC.recentClear),
  /** 渲染层移除单条后通知主进程同步菜单与系统最近文档 */
  recentRemove: (filePath) => ipcRenderer.send(IPC.recentRemove, filePath),
  /** 订阅主进程「打开最近文件」菜单项点击（参数为文件绝对路径） */
  onRecentOpen: (callback) => {
    ipcRenderer.on(IPC.recentOpen, (_event, filePath) => callback(filePath))
  },
  /** 图床上传：base64 图片交给主进程 PicGo 上传，返回 URL（ext 为按 MIME 推导的扩展名） */
  uploadImage: (base64, ext) => ipcRenderer.invoke(IPC.uploadImage, base64, ext),
  /** 获取 PicGo 配置（图床类型及各图床参数） */
  getPicGoConfig: () => ipcRenderer.invoke(IPC.getPicGoConfig),
  /** 保存 PicGo 配置到 userData 目录 */
  savePicGoConfig: (config) => ipcRenderer.invoke(IPC.savePicGoConfig, config),
  /** 同步快捷键配置到主进程，更新菜单 accelerator */
  syncShortcuts: (shortcuts) => ipcRenderer.send(IPC.syncShortcuts, shortcuts),
  /** 跨文件全文搜索：主进程递归扫描挂载目录并逐行匹配 */
  searchFiles: (roots, query) => ipcRenderer.invoke(IPC.searchFiles, roots, query),
  /** 双链索引：扫描工作区全部笔记的 [[..]]，返回节点与逐处解析后的链接边 */
  wikiScan: (roots) => ipcRenderer.invoke(IPC.wikiScan, roots),
  /** 文件式主题：列出 ~/.tmd/themes 下的全部 .css 主题（附目录绝对路径） */
  listThemes: () => ipcRenderer.invoke(IPC.themesList),
  /** 文件式主题：按裸文件名读取单个主题 CSS（主进程做路径穿越校验） */
  readTheme: (name) => ipcRenderer.invoke(IPC.themesRead, name),
  /** 文件式主题：在系统文件管理器中打开主题目录（空目录时创建并写入示例） */
  openThemesDir: () => ipcRenderer.invoke(IPC.themesOpenDir),
  /** 渲染层未捕获异常上报：仅写入本机日志，级别/来源由主进程固定 */
  reportError: (entry) => ipcRenderer.send(IPC.logReport, entry),
  /** 在系统文件管理器中打开日志目录（不存在则创建） */
  openLogsDir: () => ipcRenderer.invoke(IPC.logOpenDir),
  /** 本地历史版本：列出某文件的快照清单（最新在前，无历史为 null） */
  listHistory: (filePath) => ipcRenderer.invoke(IPC.historyList, filePath),
  /** 本地历史版本：读取单条快照正文 */
  readHistory: (filePath, id) => ipcRenderer.invoke(IPC.historyRead, filePath, id),
  /** 外部修改监视：全量同步「已打开文件」路径集合（主进程差量增删 watcher） */
  watchFiles: (paths) => ipcRenderer.invoke(IPC.watchFiles, paths),
  /** 订阅外部修改事件（kind: 'change' 内容变化 / 'unlink' 文件被移除） */
  onFileChanged: (callback) => {
    ipcRenderer.on(IPC.fileChanged, (_event, info) => callback(info))
  },
  /** 侧边栏目录监视：全量同步「已加载目录集合」（主进程差量增删 watcher） */
  watchDirs: (paths) => ipcRenderer.invoke(IPC.watchDirs, paths),
  /** 订阅目录变化事件（外部增删/改名），payload 为发生变化的目录绝对路径 */
  onDirsChanged: (callback) => {
    ipcRenderer.on(IPC.dirsChanged, (_event, dir) => callback(dir))
  },
  /** 文件管理：在目录下新建 Markdown 文件（无 .md 扩展名自动补；重名抛错），返回新路径与名称 */
  createFile: (dirPath, name) => ipcRenderer.invoke(IPC.createFile, dirPath, name),
  /** 文件管理：在目录下新建文件夹（重名抛错），返回新路径与名称 */
  createDir: (dirPath, name) => ipcRenderer.invoke(IPC.createDir, dirPath, name),
  /** 文件管理：重命名（同目录内，重名或非法名抛错），返回新路径与名称 */
  renamePath: (oldPath, name) => ipcRenderer.invoke(IPC.renamePath, oldPath, name),
  /** 文件管理：在系统文件管理器中显示该文件/文件夹 */
  revealInFolder: (targetPath) => ipcRenderer.invoke(IPC.revealInFolder, targetPath),
  /** 文件管理：删除文件/文件夹（移入系统回收站，可恢复；确认由渲染层承担） */
  deletePath: (targetPath) => ipcRenderer.invoke(IPC.deletePath, targetPath),
  /** Word / 长图离屏导出：主进程弹保存框（取消返回 null）后交隐藏窗口执行并落盘 */
  exportRun: (options) => ipcRenderer.invoke(IPC.exportRun, options),
  /** AI：读取配置视图（不含明文 Key） */
  getAiConfig: () => ipcRenderer.invoke(IPC.aiGetConfig),
  /** AI：保存配置增量（apiKey 非空才更新；clearApiKey 清除） */
  saveAiConfig: (patch) => ipcRenderer.invoke(IPC.aiSaveConfig, patch),
  /** AI：连通性测试（可传尚未保存的表单值） */
  testAiConnection: (overrides) => ipcRenderer.invoke(IPC.aiTest, overrides),
  /** AI：发起流式对话，立即返回；增量事件走 onAiStream */
  chatAi: (requestId, messages) => ipcRenderer.invoke(IPC.aiChat, { requestId, messages }),
  /** AI：中止在途请求 */
  abortAi: (requestId) => ipcRenderer.invoke(IPC.aiAbort, requestId),
  /** AI：向量嵌入（工作区检索用，按输入顺序返回） */
  embedAiTexts: (texts) => ipcRenderer.invoke(IPC.aiEmbed, texts),
  /** AI：订阅流式事件 */
  onAiStream: (callback) => {
    ipcRenderer.on(IPC.aiStream, (_event, payload) => callback(payload))
  },
}

contextBridge.exposeInMainWorld('tmdAPI', api)
