/**
 * 长图导出：分段截图计划（纯函数）+ 多段拼接（DOM 编排，依赖注入截图原语）。
 *
 * 背景：Chromium 单帧捕获受纹理上限约束（单帧物理像素约 16384），
 * 超长文档无法一次 capturePage；故按高度切段截图，再在页面内 canvas 纵向拼接。
 *
 * 清晰度归一：目标是物理清晰度不低于 2x（= 原始 CSS 像素的 2 倍）。
 * 离屏窗口的设备像素比随机器不同（1 / 2 / 3…），由调用方对文档根设置
 * CSS zoom = zoomForDpr(dpr)，使「页面 CSS 尺寸 × zoom × dpr」恒 ≥ 2 倍原始像素。
 * 本模块所有 CSS 尺寸均指 zoom 生效后测量到的值，physical = CSS × pixelRatio。
 *
 * @author chiangyang
 */
import type { CaptureRequest, CaptureResult } from './export-bridge'

/** 单段截图物理像素高上限（低于 Chromium 纹理上限 16384，留足余量） */
export const MAX_SEGMENT_PHYSICAL = 8000
/** 整图物理像素总高上限（约 60000 原始 CSS px，超过拒绝并提示） */
export const MAX_TOTAL_PHYSICAL = 120000
/** 目标输出清晰度（相对原始 CSS 像素的物理像素倍数） */
export const TARGET_SCALE = 2

/** 单个截图段 */
export interface Segment {
  /** 段顶相对文档顶的滚动偏移（zoom 坐标系 CSS px） */
  scrollYCss: number
  /** 本段视口高度（CSS px，末段可能更矮） */
  heightCss: number
}

/** 分段计划 */
export interface SegmentPlan {
  segments: Segment[]
  /** 输出 PNG 物理像素宽 */
  physicalWidth: number
  /** 输出 PNG 物理像素总高 */
  physicalHeight: number
  /** 每段请求的视口高度（CSS px，物理高不超过 MAX_SEGMENT_PHYSICAL） */
  requestHeightCss: number
}

/** 分段失败原因 */
export type SegmentError = { ok: false; reason: 'too-tall'; physicalHeight: number }
/** 分段结果 */
export type SegmentPlanResult = { ok: true; plan: SegmentPlan } | SegmentError

/**
 * zoom 归一系数：使 zoom × dpr ≥ TARGET_SCALE（即物理清晰度不低于 2x）。
 * dpr=1 → 2（放大）；dpr=2 → 1（原生 2x）；dpr=3 → 1（原生 3x，不缩小以免降质）。
 * @param dpr - 离屏窗口 devicePixelRatio
 * @returns CSS px → DIP 的换算系数
 */
export function zoomForDpr(dpr: number): number {
  if (!(dpr > 0)) return 1 // 非正数无意义，退回不缩放
  return Math.max(1, TARGET_SCALE / dpr)
}

/**
 * 按视口高度把整篇文档切为若干截图段（纯函数）。
 * @param widthCss - zoom 后文档内容宽（CSS px）
 * @param heightCss - zoom 后文档总高（CSS px）
 * @param pixelRatio - 实际物理像素 / CSS 像素（= zoom × dpr）
 */
export function planSegments(
  widthCss: number,
  heightCss: number,
  pixelRatio: number,
): SegmentPlanResult {
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  const physicalHeight = Math.round(heightCss * ratio)
  const physicalWidth = Math.round(widthCss * ratio)
  if (physicalHeight > MAX_TOTAL_PHYSICAL) {
    return { ok: false, reason: 'too-tall', physicalHeight }
  }
  // 单段 CSS 高上限：物理上限 / pixelRatio（向下取整，保证段段不越界）
  const requestHeightCss = Math.max(1, Math.floor(MAX_SEGMENT_PHYSICAL / ratio))
  const segments: Segment[] = []
  let y = 0
  while (y < heightCss) {
    const h = Math.min(requestHeightCss, heightCss - y)
    segments.push({ scrollYCss: Math.round(y), heightCss: Math.ceil(h) })
    y += requestHeightCss
  }
  // 空文档也截一段（至少得到页面背景，避免输出 0 高度图片）。
  // 输出高度必须非零：拼接循环以 physicalHeight 为终止条件，为 0 时循环不执行、
  // 直接抛「分段截图未产生内容」，长图导出整体失败
  if (segments.length === 0) {
    segments.push({ scrollYCss: 0, heightCss: requestHeightCss })
    return {
      ok: true,
      plan: {
        segments,
        physicalWidth,
        physicalHeight: Math.round(requestHeightCss * ratio),
        requestHeightCss,
      },
    }
  }
  return { ok: true, plan: { segments, physicalWidth, physicalHeight, requestHeightCss } }
}

/** 截图原语（由离屏页桥接提供，便于注入与测试） */
export type CaptureFn = (req: CaptureRequest) => Promise<CaptureResult | null>
/** 滚动原语：滚到指定偏移并等待渲染稳定（由离屏页提供） */
export type ScrollFn = (scrollYCss: number) => Promise<void>

/**
 * 依分段计划逐段截图并在 canvas 纵向拼接为整页 PNG 字节。
 *
 * 自纠正两点：
 * - 段偏移按「上一段实际捕获到的高度」推进而非计划的固定步长：窗口管理器若把
 *   视口钳制到屏幕高度以内，实际捕获高度会小于请求高度，按实际值推进即无缝续接
 * - 画布宽度取首段实际物理宽（而非估算值），避免四舍五入导致逐段错位
 *
 * @param plan - 分段计划（总高、每段请求高与输出高度）
 * @param metrics - widthCss 视口内容宽 / zoom CSS→DIP 系数 / pixelRatio 物理像素比（zoom 坐标系）
 * @param capture - 截图原语
 * @param scrollTo - 滚动 + 等待原语
 * @param background - 画布底色（页面背景，避免末段留透明条）
 * @returns PNG 文件字节
 */
export async function composeLongPng(
  plan: SegmentPlan,
  metrics: { widthCss: number; zoom: number; pixelRatio: number },
  capture: CaptureFn,
  scrollTo: ScrollFn,
  background = '#ffffff',
): Promise<Uint8Array> {
  const { widthCss, zoom } = metrics
  const ratio = metrics.pixelRatio > 0 ? metrics.pixelRatio : 1

  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let drawnPhysical = 0
  let offsetCss = 0
  // 上限轮次防死循环（实际段高为 0 时抛错退出）
  const maxRounds = plan.segments.length + 8
  for (let round = 0; round < maxRounds && drawnPhysical < plan.physicalHeight; round++) {
    const remainingCss = Math.max(1, plan.physicalHeight / ratio - offsetCss)
    const requestCss = Math.min(plan.requestHeightCss, remainingCss)
    await scrollTo(offsetCss)
    const shot = await capture({ widthCss, heightCss: requestCss, zoom })
    if (!shot || shot.physicalWidth <= 0 || shot.physicalHeight <= 0) {
      throw new Error('分段截图失败')
    }
    if (!canvas) {
      // 首段实测宽即输出宽；高度用计划值（+ 首段实测高兜底）
      canvas = document.createElement('canvas')
      canvas.width = shot.physicalWidth
      canvas.height = Math.max(plan.physicalHeight, shot.physicalHeight)
      ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d context 不可用')
      ctx.fillStyle = background
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    const img = await loadImage(shot.dataUrl)
    ctx?.drawImage(img, 0, drawnPhysical)
    drawnPhysical += shot.physicalHeight
    offsetCss += shot.physicalHeight / ratio
  }
  if (!canvas || drawnPhysical <= 0) throw new Error('分段截图未产生内容')

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas 导出 PNG 失败')
  return new Uint8Array(await blob.arrayBuffer())
}

/** 加载 data URL 为 HTMLImageElement（解码完成后 resolve） */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('分段图片解码失败'))
    img.src = dataUrl
  })
}
