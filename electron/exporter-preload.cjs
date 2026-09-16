/**
 * 离屏导出页专用 preload：只暴露导出任务所需的四个桥接方法
 * （远小于主窗口 preload，遵循最小权限原则）。
 *
 * 按 src/export-bridge.ts 的 ExporterBridge 接口标注（tsc checkJs 校验），
 * 与接口不一致会在编译期报错。
 *
 * @author chiangyang
 */
const { contextBridge, ipcRenderer } = require('electron')
const IPC = require('./ipc.cjs')

/** @type {import('../src/export-bridge.ts').ExporterBridge} */
const api = {
  /** 订阅主进程下发的导出任务（离屏页加载完成后注册） */
  onTask: (callback) => {
    ipcRenderer.on(IPC.exporterTask, (_event, task) => callback(task))
  },
  /** 回传任务结果（字节或错误）；主进程负责写入用户选定路径 */
  taskDone: (result) => ipcRenderer.invoke(IPC.exporterDone, result),
  /** 原语：设置视口尺寸并对当前视口截图 */
  capture: (req) => ipcRenderer.invoke(IPC.exporterCapture, req),
  /** 原语：白名单读取本地图片为 data URI（失败返回 null） */
  readImage: (fileUrl) => ipcRenderer.invoke(IPC.exporterReadImage, fileUrl),
}

contextBridge.exposeInMainWorld('exporterAPI', api)
