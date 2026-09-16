/**
 * 离屏导出页（export-renderer.html）与主进程 exporter 服务之间的桥接契约。
 *
 * 分工（命令模式）：主窗口只发起 exportRun（见 native.ts）；真正的导出任务在
 * 隐藏窗口内完成——主进程仅提供 Electron 独有原语（视口截图、本地图片读盘），
 * 渲染、等待、分段、拼接、OOXML 转换等编排全部留在离屏页 TS 侧，可被 vitest 覆盖。
 *
 * @author chiangyang
 */
import type { ExportDocument } from './export-doc'

/** 离屏导出任务：载体无关文档 + 任务种类 + 图片相对路径解析目录 */
export interface ExportTask extends ExportDocument {
  kind: 'word' | 'longimage'
  /** 当前文档所在目录绝对路径（相对路径图片本地化用）；未保存文档为 null */
  baseDir: string | null
}

/** 视口内的矩形区域（CSS px，相对视口左上角） */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 截图原语入参（CSS px）。
 *
 * 两种模式：
 * - 视口模式（widthCss + heightCss）：设置窗口内容尺寸后截取整个视口，长图分段用
 * - 区域模式（region）：不改窗口尺寸，截取当前视口内的一块区域，公式栅格化用
 *
 * zoom 为 CSS px → DIP 的换算系数（离屏页对文档根设置 zoom 后，
 * 1 个 CSS px 对应 zoom 个 DIP），主进程据此换算窗口尺寸与截图矩形。
 */
export interface CaptureRequest {
  /** 视口模式：目标内容宽（CSS px） */
  widthCss?: number
  /** 视口模式：目标内容高（CSS px） */
  heightCss?: number
  /** 区域模式：待截取区域（CSS px） */
  region?: CaptureRegion
  /** CSS px → DIP 换算系数（1 或 2/dpr，见 export-image.zoomForDpr） */
  zoom: number
}

/** 视口截图原语结果 */
export interface CaptureResult {
  /** 截取到的 PNG data URL */
  dataUrl: string
  /** 截图实际物理像素宽 */
  physicalWidth: number
  /** 截图实际物理像素高 */
  physicalHeight: number
  /** 实际物理像素 / 请求的 CSS 像素（= zoom × 设备像素比），供离屏页核对清晰度 */
  pixelRatio: number
}

/** 任务结果：成功携带文件字节，失败携带错误信息 */
export type ExportTaskResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

/** 离屏页经 exporter-preload 拿到的受控 API（无 Node 权限，contextIsolation） */
export interface ExporterBridge {
  /** 订阅主进程下发的任务（串行：同一时刻只有一个任务） */
  onTask(callback: (task: ExportTask) => void): void
  /** 回传任务结果；主进程收到成功结果后写入用户选定的目标文件 */
  taskDone(result: ExportTaskResult): Promise<void>
  /** 原语：按请求模式设置视口或截取视口区域（失败返回 null） */
  capture(req: CaptureRequest): Promise<CaptureResult | null>
  /** 原语：按白名单读取本地图片文件并转 data URI；失败/非法返回 null */
  readImage(fileUrl: string): Promise<string | null>
}

declare global {
  interface Window {
    /** 仅离屏导出页存在（exporter-preload 注入） */
    exporterAPI?: ExporterBridge
  }
}
