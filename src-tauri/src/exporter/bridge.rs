//! 离屏导出页的 exporterAPI 门面（对应 Electron exporter-preload.cjs）。

/// 注入导出窗口的初始化脚本：提供 export-bridge.ts 的 ExporterBridge。
/// 与主窗口 TMD_API_SHIM 同机制（__TAURI__.core.invoke / event.listen）。
/// 字节回传 base64：invoke 载荷是 JSON，Uint8Array 直转会膨胀成数字数组。
pub(crate) const EXPORTER_API_SHIM: &str = r#"
(function () {
  if (window.exporterAPI) return
  var core = window.__TAURI__ && window.__TAURI__.core
  var evt = window.__TAURI__ && window.__TAURI__.event
  if (!core || !core.invoke || !evt) return
  var taskCbs = []
  function u8ToB64(u8) {
    var s = '', chunk = 0x8000
    for (var i = 0; i < u8.length; i += chunk)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
    return btoa(s)
  }
  evt.listen('tmd-exporter-task', function (e) {
    for (var i = 0; i < taskCbs.length; i++) taskCbs[i](e.payload)
  })
  window.exporterAPI = {
    onTask: function (cb) { taskCbs.push(cb) },
    taskDone: function (result) {
      return core.invoke('tmd_exporter_done', {
        payload: {
          ok: !!result.ok,
          bytesB64: result.ok && result.bytes ? u8ToB64(result.bytes) : null,
          error: result && result.error ? String(result.error) : null,
        },
      })
    },
    capture: function (req) { return core.invoke('tmd_exporter_capture', { req: req }) },
    readImage: function (fileUrl) {
      return core.invoke('tmd_exporter_read_image', { fileUrl: fileUrl })
    },
  }
})()
"#;
