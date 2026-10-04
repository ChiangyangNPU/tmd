/**
 * 排版设置：编辑区字体 / 字号 / 行距 / 编辑区宽度 / 自动换行
 *
 * - 配置经 <style id="typography-style"> 注入 CSS 变量，style.css 以
 *   var(--editor-*, 默认值) 消费——与主题预设同属纯 CSS 变量层，
 *   即时生效且不触碰编辑器实例；仅作用于正文编辑区
 * - 各项空值 = 跟随默认（不注入对应变量）
 * - 字体预设 radio 与自定义输入联动：输入非空即优先自定义（取消 radio 选中），
 *   点选预设则清空输入
 *
 * @author chiangyang
 */
import { getTypography, setTypography } from './store'
import type { Typography } from './store'

/** 字体预设（stack 为完整 font-family 栈；default = ''，跟随全局系统栈） */
export interface FontPreset {
  id: string
  stack: string
}

export const FONT_PRESETS: FontPreset[] = [
  { id: 'default', stack: '' },
  {
    id: 'song',
    stack: `Georgia, 'Songti SC', SimSun, 'Noto Serif CJK SC', serif`,
  },
  {
    id: 'hei',
    stack: `'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`,
  },
  { id: 'kai', stack: `'Kaiti SC', KaiTi, STKaiti, serif` },
]

/** 应用排版设置：非默认项注入 CSS 变量（空值不注入，回落 style.css 默认） */
/**
 * 清洗用户自定义的 CSS 值：设置面板自由输入的字符串若含花括号可闭合
 * `:root {` 规则并注入任意 CSS（textContent 不解析标签，无 XSS，但可破坏
 * 界面样式）。数值型输入（字号/行高/页宽）同样过一遍，行为统一。
 */
const safeCssValue = (value: string | number): string => String(value).replace(/[{}]/g, '')

export function applyTypography(): void {
  const t = getTypography()
  let style = document.getElementById('typography-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'typography-style'
    document.head.appendChild(style)
  }
  const lines: string[] = []
  if (t.font) lines.push(`  --editor-font: ${safeCssValue(t.font)};`)
  if (t.fontSize) lines.push(`  --editor-font-size: ${safeCssValue(t.fontSize)}px;`)
  if (t.lineHeight) lines.push(`  --editor-line-height: ${safeCssValue(t.lineHeight)};`)
  if (t.pageWidth === 'full') lines.push('  --editor-page-width: 100%;')
  else if (t.pageWidth) lines.push(`  --editor-page-width: ${safeCssValue(t.pageWidth)}px;`)
  if (t.wrap === 'off') {
    lines.push('  --editor-white-space: pre;')
    lines.push('  --editor-overflow-x: auto;')
  }
  style.textContent = lines.length ? `:root {\n${lines.join('\n')}\n}` : ''
}

/** 保存排版设置（持久化 + 即时应用） */
export function changeTypography(next: Typography): void {
  setTypography(next)
  applyTypography()
}

// ---------- 字号缩放（Ctrl/Cmd+滚轮 / 触控板捏合） ----------

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 28
/** fontSize 存储空串时的实际生效字号（与 style.css 默认值一致） */
export const FONT_SIZE_DEFAULT = 16

/**
 * 缩放后的新字号（纯函数，可独立单测）：
 * 空档位按默认值起算，逐级 ±1px，钳制在 [MIN, MAX]。
 * @param current 存储中的字号档位（'' 或数字串）
 * @param delta 缩放步数（+1 放大 / -1 缩小，连续滚轮多次触发累加）
 */
export function nextFontSize(current: string, delta: number): string {
  const base = Number.parseInt(current, 10) || FONT_SIZE_DEFAULT
  return String(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, base + delta)))
}

/** 缩放字号并持久化（返回新字号供 HUD 展示） */
export function adjustFontSize(delta: number): number {
  const next = nextFontSize(getTypography().fontSize, delta)
  changeTypography({ ...getTypography(), fontSize: next })
  return Number(next)
}

/** 设置面板反射当前排版配置（打开面板时调用） */
export function reflectTypography(): void {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return
  const t = getTypography()

  /** 勾选 name 组中 value 匹配的 radio（无匹配则全部不勾，如自定义字体态） */
  const checkRadio = (name: string, value: string) => {
    overlay.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      ;(input as HTMLInputElement).checked = (input as HTMLInputElement).value === value
    })
  }

  // 字体：命中预设 → 勾选对应 radio；自定义栈 → 全不勾并回填输入框
  const preset = FONT_PRESETS.find((p) => p.stack !== '' && p.stack === t.font)
  checkRadio('set-font', preset ? preset.id : t.font ? '' : 'default')
  const customInput = overlay.querySelector('#set-font-custom') as HTMLInputElement | null
  if (customInput) customInput.value = preset ? '' : t.font

  checkRadio('set-fs', t.fontSize)
  checkRadio('set-lh', t.lineHeight)
  checkRadio('set-pw', t.pageWidth)
  const wrapBox = overlay.querySelector('#set-wrap') as HTMLInputElement | null
  if (wrapBox) wrapBox.checked = t.wrap !== 'off'
}

/** 排版区控件事件装配（boot 时调用一次） */
export function wireTypography(): void {
  const overlay = document.getElementById('settings-overlay')
  if (!overlay) return

  // 字体预设：点选即生效并清空自定义输入
  overlay.querySelectorAll('input[name="set-font"]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = (input as HTMLInputElement).value
      const stack = FONT_PRESETS.find((p) => p.id === id)?.stack ?? ''
      const customInput = overlay.querySelector('#set-font-custom') as HTMLInputElement | null
      if (customInput) customInput.value = ''
      changeTypography({ ...getTypography(), font: stack })
    })
  })
  // 自定义字体：输入即生效（参照自定义 CSS 的即时应用），并取消预设选中
  const customInput = overlay.querySelector('#set-font-custom') as HTMLInputElement | null
  customInput?.addEventListener('input', () => {
    overlay.querySelectorAll('input[name="set-font"]').forEach((el) => {
      ;(el as HTMLInputElement).checked = false
    })
    changeTypography({ ...getTypography(), font: customInput.value.trim() })
  })

  // 档位组：字号 / 行距 / 编辑区宽度（radio value 即存储值，'' = 默认）
  const wireRadio = (name: string, pick: (t: Typography, value: string) => Typography) => {
    overlay.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      input.addEventListener('change', () => {
        changeTypography(pick(getTypography(), (input as HTMLInputElement).value))
      })
    })
  }
  wireRadio('set-fs', (t, value) => ({ ...t, fontSize: value }))
  wireRadio('set-lh', (t, value) => ({ ...t, lineHeight: value }))
  wireRadio('set-pw', (t, value) => ({ ...t, pageWidth: value }))

  // 自动换行开关
  overlay.querySelector('#set-wrap')?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked
    changeTypography({ ...getTypography(), wrap: on ? 'on' : 'off' })
  })
}
