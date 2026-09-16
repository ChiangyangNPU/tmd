/**
 * KaTeX auto-render 扩展（katex 的 contrib 入口未随包提供类型声明，
 * 且 exports 映射为 "./*": "./*"，故按本项目惯例在此补最小声明）。
 *
 * 仅声明导出侧用到的字段，不追求覆盖 auto-render 的全部选项。
 */
declare module 'katex/dist/contrib/auto-render.mjs' {
  /** 公式分隔符定义（display=true 时按独立公式排版） */
  interface AutoRenderDelimiter {
    left: string
    right: string
    display: boolean
  }

  /** 自动渲染选项（本项目仅用到 delimiters 与 throwOnError） */
  interface AutoRenderOptions {
    delimiters?: AutoRenderDelimiter[]
    /** 单个公式渲染失败是否抛出（默认 false：保留原文，不中断整页） */
    throwOnError?: boolean
  }

  /** 扫描元素内文本，把分隔符包裹的内容渲染为 KaTeX 公式（原地替换 DOM） */
  export default function renderMathInElement(elem: HTMLElement, options?: AutoRenderOptions): void
}
