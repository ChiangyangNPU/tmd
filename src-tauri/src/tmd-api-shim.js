/**
 * TMD 壳层 shim：页面加载前注入 `window.tmdAPI`（契约见 src/native.ts）。
 *
 * 由 main.rs 经 `include_str!` 编译期内嵌进 initialization_script，不读运行时
 * 路径；改动后需重新构建应用才生效。
 */
(function () {
  if (window.tmdAPI) return
  var core = window.__TAURI__ && window.__TAURI__.core
  if (!core || !core.invoke) return
  var invoke = core.invoke
  var impl = {
    isNative: true,
    // 壳层能力声明：渲染层据此降级 UI。图床已用 Rust 重写四条通道
    // （smms/github/aliyun/imgur，见 picgo.rs）；更新已接 tauri-plugin-updater
    capabilities: { picgo: true, updater: true },
    readFile: function (filePath) { return invoke('tmd_read_file', { filePath: filePath }) },
    saveFile: function (filePath, content, meta) {
      return invoke('tmd_save_file', { filePath: filePath, content: content, meta: meta || null })
    },
    readDir: function (dirPath) { return invoke('tmd_read_dir', { dirPath: dirPath }) },
    openFile: function () { return invoke('tmd_open_file') },
    openFolder: function () { return invoke('tmd_open_folder') },
    saveFileAs: function (content, defaultName, meta) {
      return invoke('tmd_save_file_as', { content: content, defaultName: defaultName || null, meta: meta || null })
    },
    exportAs: function (options) { return invoke('tmd_export_as', { options: options }) },
    searchFiles: function (roots, query) { return invoke('tmd_search_files', { roots: roots, query: query }) },
    wikiScan: function (roots) { return invoke('tmd_wiki_scan', { roots: roots }) },
    watchFiles: function (paths) { invoke('tmd_watch_files', { paths: paths }) },
    watchDirs: function (paths) { invoke('tmd_watch_dirs', { paths: paths }) },
    onFileChanged: function (cb) { tmdOn('tmd-file-changed', cb) },
    onDirsChanged: function (cb) { tmdOn('tmd-dirs-changed', cb) },
    // 图床（Rust 重写，配置兼容 Electron 的 picgo-config.json）
    uploadImage: function (base64, ext) { return invoke('tmd_picgo_upload', { base64: base64, ext: ext }) },
    getPicGoConfig: function () { return invoke('tmd_picgo_get_config') },
    savePicGoConfig: function (config) { return invoke('tmd_picgo_save_config', { config: config }) },
    listHistory: function (filePath) { return invoke('tmd_list_history', { filePath: filePath }) },
    readHistory: function (filePath, id) { return invoke('tmd_read_history', { filePath: filePath, id: id }) },
    setLocaleInfo: function (info) { invoke('tmd_set_locale_info', { labels: (info && info.labels) || {}, locale: (info && info.locale) || '' }) },
    syncShortcuts: function (shortcuts) { invoke('tmd_sync_shortcuts', { shortcuts: shortcuts || {} }) },
    setAutosaveEnabled: function (enabled) { invoke('tmd_set_autosave_enabled', { enabled: !!enabled }) },
    setDirty: function (dirty) { invoke('tmd_set_dirty', { dirty: !!dirty }) },
    setThemeSource: function (isDark) { return invoke('tmd_set_theme_source', { isDark: !!isDark }) },
    winMinimize: function () { invoke('tmd_win_minimize') },
    winMaximizeToggle: function () { invoke('tmd_win_max_toggle') },
    winClose: function () { invoke('tmd_win_close') },
    recentSync: function (entries) { invoke('tmd_recent_sync', { entries: entries || [] }) },
    recentAdd: function (entry) { invoke('tmd_recent_add', { entry: entry }) },
    recentClear: function () { invoke('tmd_recent_clear') },
    recentRemove: function (path) { invoke('tmd_recent_remove', { path: path }) },
    ready: function () {
      var pending = listenPending
      listenPending = []
      return Promise.all(pending)
        .catch(function () {})
        .then(function () { return invoke('tmd_ready') })
    },
    onOpenPath: function (cb) { tmdOn('tmd-open-path', cb) },
    onMenu: function (cb) { tmdOn('tmd-menu', cb) },
    onRecentOpen: function (cb) { tmdOn('tmd-recent-open', cb) },
    onAutosave: function (cb) { tmdOn('tmd-autosave', cb) },
    onWindowMaximize: function (cb) { tmdOn('tmd-win-max-changed', cb) },
    // Tauri 独有：文件拖放经原生拦截（dragDropEnabled 默认开启，HTML5 drop
    // 不携带文件），路径由 tauri://drag-drop 事件下发
    onDropPaths: function (cb) {
      // tmdOn 回调收到的已是 payload 本身（{paths, position}），勿再解包一层
      tmdOn('tauri://drag-drop', function (payload) {
        cb((payload && payload.paths) || [])
      })
    },
    getAiConfig: function () { return invoke('tmd_ai_get_config') },
    saveAiConfig: function (patch) { return invoke('tmd_ai_save_config', { patch: patch || {} }) },
    testAiConnection: function (overrides) { return invoke('tmd_ai_test', { overrides: overrides || {} }) },
    // Rust 侧命令参数是单个 request 对象（对应 electron ipc-ai.cjs 的 request 入参），
    // 必须放进 request 键，平铺 requestId/messages 会因缺键被 invoke 直接拒绝
    chatAi: function (requestId, messages) { return invoke('tmd_ai_chat', { request: { requestId: requestId, messages: messages } }) },
    abortAi: function (requestId) { return invoke('tmd_ai_abort', { requestId: requestId }) },
    embedAiTexts: function (texts) { return invoke('tmd_ai_embed', { texts: texts }) },
    onAiStream: function (cb) { tmdOn('tmd-ai-stream', cb) },
    reportError: function (entry) { invoke('tmd_report_error', { entry: entry }) },
    openLogsDir: function () { return invoke('tmd_open_logs_dir') },
    saveImage: function (options) { return invoke('tmd_save_image', { dir: options.dir, name: options.name, base64: options.base64 }) },
    readDroppedFile: function (filePath) { return invoke('tmd_read_dropped_file', { filePath: filePath }) },
    openExternal: function (url) { return invoke('tmd_open_external', { url: url }) },
    openLocalFile: function (filePath) { return invoke('tmd_open_local_file', { filePath: filePath }) },
    revealInFolder: function (targetPath) { return invoke('tmd_reveal_in_folder', { targetPath: targetPath }) },
    deletePath: function (targetPath) { return invoke('tmd_delete_path', { targetPath: targetPath }) },
    createFile: function (dirPath, name) { return invoke('tmd_create_file', { dirPath: dirPath, name: name }) },
    createDir: function (dirPath, name) { return invoke('tmd_create_dir', { dirPath: dirPath, name: name }) },
    renamePath: function (oldPath, name) { return invoke('tmd_rename_path', { oldPath: oldPath, name: name }) },
    listThemes: function () { return invoke('tmd_list_themes') },
    readTheme: function (name) { return invoke('tmd_read_theme', { name: name }) },
    openThemesDir: function () { return invoke('tmd_open_themes_dir') },
    getExportAssets: function () { return invoke('tmd_get_export_assets') },
    // 自动更新（tauri-plugin-updater）：检查 → 原生对话框询问 → 下载安装 → 重启；
    // 重启用前置「保存并重启」握手（onSaveRequest / reportSaveResult）
    checkForUpdates: function () { return invoke('tmd_update_check') },
    downloadUpdate: function () { invoke('tmd_update_download') },
    installUpdate: function () { invoke('tmd_update_install') },
    setAutoCheckUpdate: function (enabled) { invoke('tmd_update_set_auto', { enabled: !!enabled }) },
    onUpdateStatus: function (cb) { tmdOn('tmd-update-status', cb) },
    onSaveRequest: function (cb) { tmdOn('tmd-doc-save-request', cb) },
    reportSaveResult: function (ok) { invoke('tmd_doc_save_result', { ok: !!ok }) },
    exportRun: function (options) { return invoke('tmd_export_run', { options: options }) },
    print: function (name, options) { return invoke('tmd_print', { name: name || null, options: options || null }) },
  }
  var listened = {}
  // listen 注册是异步 IPC（Electron 的 ipcRenderer.on 是同步本地注册——移植
  // 竞态：ready 先到主进程、early-flush 的 emit 落在注册完成前=入真空，文件
  // 关联打不开文档）。ready 前必须等全部注册在主进程侧落地
  var listenPending = []
  function tmdOn(event, cb) {
    if (!listened[event]) {
      listened[event] = []
      listenPending.push(
        window.__TAURI__.event.listen(event, function (e) {
          var cbs = listened[event]
          for (var i = 0; i < cbs.length; i++) cbs[i](e.payload)
        })
      )
    }
    listened[event].push(cb)
  }
  window.tmdAPI = new Proxy(impl, {
    get: function (target, prop) {
      if (prop in target) return target[prop]
      return function () {
        console.warn('[tmd-tauri-spike] 通道未实现（no-op）:', String(prop))
      }
    },
  })
  // 自绘标题栏拖拽区：Electron 用 CSS -webkit-app-region（02-toolbar.css），
  // WebView2 / WKWebView 不解析该属性，这里按同款选择器语义复刻——
  // .toolbar / .toolbar-left 为拖拽区，.toolbar button / .toolbar .word-count 豁免；
  // 与 02-toolbar.css 双侧同步维护（同 wikilinks 的两侧同构约定）。
  function dragHit(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.matches('.toolbar button, .toolbar .word-count')) return false
      if (n.matches('.toolbar, .toolbar-left')) return true
    }
    return false
  }
  document.addEventListener('mousedown', function (e) {
    // 左键且非双击按下时拖动窗口；双击交给 dblclick
    if (e.button === 0 && e.detail === 1 && dragHit(e.target)) invoke('plugin:window|start_dragging')
  })
  // 双击工具栏空白 = 最大化/还原。Win/Linux 由 hidden 标题栏的系统行为提供；
  // mac 上扩大的标题栏容器实测完全穿透点击（单/双击都到不了原生层），原生
  // 缩放不会触发——三平台统一由此接管（mac 系统偏好「连按两下」的非默认
  // 值不跟随，按 Electron 默认语义缩放；如需跟随后续读
  // AppleActionOnDoubleClick 偏好再分流）
  document.addEventListener('dblclick', function (e) {
    if (dragHit(e.target)) invoke('tmd_win_max_toggle')
  })
})()
