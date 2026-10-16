/**
 * 图床上传（PicGo-Core）。
 *
 * PicGo 仅 Node 环境可用，故放在主进程；渲染层经 IPC 传 base64 与扩展名，
 * 主进程写临时文件后交给 PicGo 上传，返回图片 URL。
 *
 * 依赖注入（ipcMain/app/PicGo 由 main.cjs 传入）而非顶层 require：
 * 本模块可被单测直接 require，不拉起 PicGo 依赖树（与 exporter.cjs 同构）。
 *
 * @author chiangyang
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const state = require('./app-state.cjs')

/** 图床上传允许的图片扩展名（渲染层按 MIME 推导后传入，白名单外回落 .png） */
const UPLOAD_EXT_ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

/**
 * 创建图床上传服务。
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   IPC: typeof import('./ipc.cjs'),
 *   app: import('electron').App,
 *   PicGo: typeof import('picgo').PicGo,
 * }} deps
 */
function createPicGo({ ipcMain, IPC, app, PicGo }) {
  /** PicGo 配置文件路径（userData 目录，随应用卸载清理） */
  function picgoConfigPath() {
    return path.join(app.getPath('userData'), 'picgo-config.json')
  }

  /** 懒加载 PicGo 实例：配置文件放 userData，不使用默认的 ~/.picgo/config.json */
  /** @type {import('picgo').PicGo | null} */
  let picgoInstance = null
  /** @returns {import('picgo').PicGo} */
  function getPicGo() {
    if (!picgoInstance) {
      picgoInstance = new PicGo(picgoConfigPath())
    }
    return picgoInstance
  }

  /** 注册 uploadImage / getPicGoConfig / savePicGoConfig 三条 IPC */
  function register() {
    /**
     * 上传图片到图床：渲染层传 base64 与扩展名，主进程写临时文件后交给 PicGo 上传，
     * 返回图片 URL；失败返回 null。
     * @param {unknown} _event
     * @param {unknown} base64  纯 base64 字符串（不含 data:image/...;base64, 前缀）
     * @param {unknown} ext     图片扩展名（如 '.png'，由渲染层按 MIME 推导）
     */
    ipcMain.handle(IPC.uploadImage, async (event, base64, ext) => {
      state.assertMainWindow(event)
      if (typeof base64 !== 'string' || !base64) return null
      // PicGo 按扩展名判定 mime，故由渲染层传入并在此校验；缺省/非法一律按 png
      const safeExt =
        typeof ext === 'string' && UPLOAD_EXT_ALLOWED.has(ext.toLowerCase())
          ? ext.toLowerCase()
          : '.png'
      let tmpFile = ''
      try {
        // 写临时文件：PicGo 的 path transformer 只接受文件路径。
        // 文件名带随机后缀：多个标签同时粘贴走图床时，仅用时间戳会撞名互相覆盖
        tmpFile = path.join(os.tmpdir(), `tmd-picgo-${randomUUID()}${safeExt}`)
        await fs.writeFile(tmpFile, Buffer.from(base64, 'base64'))
        const picgo = getPicGo()
        /** @type {unknown} */
        const result = await picgo.upload([tmpFile])
        if (Array.isArray(result) && result[0] && typeof result[0].imgUrl === 'string') {
          return result[0].imgUrl
        }
        return null
      } catch (err) {
        console.error('[tmd] 图床上传失败', err)
        return null
      } finally {
        // 清理临时文件
        if (tmpFile) {
          fs.unlink(tmpFile).catch(() => {})
        }
      }
    })

    /** 获取 PicGo 配置（图床类型及各图床参数） */
    ipcMain.handle(IPC.getPicGoConfig, async () => {
      try {
        const picgo = getPicGo()
        const config = picgo.getConfig()
        // picBed 包含 current（当前图床）和各图床参数
        return config.picBed || { current: '' }
      } catch (err) {
        console.error('[tmd] 获取 PicGo 配置失败', err)
        return { current: '' }
      }
    })

    /** 保存 PicGo 配置到 userData 目录 */
    /** @param {unknown} event @param {unknown} config */
    ipcMain.handle(IPC.savePicGoConfig, async (event, config) => {
      state.assertMainWindow(event)
      if (!config || typeof config !== 'object') return false
      try {
        const picgo = getPicGo()
        // saveConfig 会写入配置文件并持久化
        picgo.saveConfig({ picBed: config })
        return true
      } catch (err) {
        console.error('[tmd] 保存 PicGo 配置失败', err)
        return false
      }
    })
  }

  return { register }
}

module.exports = { createPicGo }
