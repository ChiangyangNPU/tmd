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
}

module.exports = channels
