/**
 * IPC 通道名常量：主进程与 preload 共用，杜绝两边手写字符串漂移。
 *
 * 键名与类型由 src/native.ts 的 IpcChannels 接口约束（tsc checkJs 校验）：
 * 缺键、多键、改错类型都会在编译期报错。
 * 注意：标注必须放在 const 声明上（校验字面量本身）；
 * 直接标注 module.exports 只约束导出类型，缺键不会被拦截。
 */

/** @type {import('../src/native.ts').IpcChannels} */
const channels = {
  openFile: 'tmd:open-file',
  readFile: 'tmd:read-file',
  readDir: 'tmd:read-dir',
  openFolder: 'tmd:open-folder',
  saveFile: 'tmd:save-file',
  saveFileAs: 'tmd:save-file-as',
  exportAs: 'tmd:export-as',
  print: 'tmd:print',
  setDirty: 'tmd:set-dirty',
  menu: 'tmd:menu',
  autosave: 'tmd:autosave',
  openPath: 'tmd:open-path',
  setLocaleInfo: 'tmd:set-locale-info',
  ready: 'tmd:ready',
  setAutosaveEnabled: 'tmd:set-autosave-enabled',
  saveImage: 'tmd:save-image',
  openExternal: 'tmd:open-external',
  openLocalFile: 'tmd:open-local-file',
  updateCheck: 'tmd:update-check',
  updateStatus: 'tmd:update-status',
  updateDownload: 'tmd:update-download',
  updateInstall: 'tmd:update-install',
  updateAutoCheck: 'tmd:update-auto-check',
  // 更新重启握手：「保存并重启」时主进程请求渲染层保存当前文档，渲染层
  // 处理完回报结果——另存为对话框 / 写盘耗时都在等待范围内，主进程不设超时
  // （超时后重启会把未写完的文档留在半路；悬挂的代价只是更新不立即安装，
  // autoInstallOnAppQuit 会在下次退出时兜底）
  docSaveRequest: 'tmd:doc-save-request',
  docSaveResult: 'tmd:doc-save-result',
  setThemeSource: 'tmd:set-theme-source',
  winMinimize: 'tmd:win-minimize',
  winMaximizeToggle: 'tmd:win-maximize-toggle',
  winClose: 'tmd:win-close',
  winMaxChanged: 'tmd:win-max-changed',
  recentSync: 'tmd:recent-sync',
  recentAdd: 'tmd:recent-add',
  recentClear: 'tmd:recent-clear',
  recentRemove: 'tmd:recent-remove',
  recentOpen: 'tmd:recent-open',
  // 图床上传（PicGo-Core）
  uploadImage: 'tmd:upload-image',
  getPicGoConfig: 'tmd:get-picgo-config',
  savePicGoConfig: 'tmd:save-picgo-config',
  // 快捷键自定义：渲染层将配置同步给主进程以更新菜单 accelerator
  syncShortcuts: 'tmd:sync-shortcuts',
  // 跨文件全文搜索：主进程递归扫描挂载目录并逐行匹配
  searchFiles: 'tmd:search-files',
  // 文件式主题：主题目录扫描 / 单文件读取 / 在系统文件管理器中打开目录
  themesList: 'tmd:themes-list',
  themesRead: 'tmd:themes-read',
  themesOpenDir: 'tmd:themes-open-dir',
  // 离屏导出（Word / 长图）：主窗口发起 → 隐藏窗口执行 → 原语回传
  exportRun: 'tmd:export-run',
  exporterTask: 'tmd:exporter-task',
  exporterDone: 'tmd:exporter-done',
  exporterCapture: 'tmd:exporter-capture',
  exporterReadImage: 'tmd:exporter-read-image',
  // 日志与诊断：渲染层异常上报（仅本地落盘）/ 在文件管理器中打开日志目录
  logReport: 'tmd:log-report',
  logOpenDir: 'tmd:log-open-dir',
  // 本地历史版本：快照留存由主进程在写盘时自动完成（无 IPC），
  // 这两个通道仅供渲染层查阅清单与读取正文
  historyList: 'tmd:history-list',
  historyRead: 'tmd:history-read',
  // 外部修改检测：渲染层全量同步打开文件集合，主进程推送变化事件
  watchFiles: 'tmd:watch-files',
  fileChanged: 'tmd:file-changed',
  // 侧边栏文件管理：新建文件 / 新建文件夹 / 重命名 / 在系统中显示
  createFile: 'tmd:create-file',
  createDir: 'tmd:create-dir',
  renamePath: 'tmd:rename-path',
  revealInFolder: 'tmd:reveal-in-folder',
}

module.exports = channels
