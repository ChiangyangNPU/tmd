import { describe, it, expect } from 'vitest'
import {
  resolveThemeSelection,
  parseThemeRadioValue,
  displayThemeName,
  FILE_THEME_PREFIX,
} from '../theme-presets'

describe('resolveThemeSelection', () => {
  it('文件主题激活时优先高亮文件项（与深浅、预设无关）', () => {
    expect(resolveThemeSelection(false, 'default', '晚霞.css')).toBe('file:晚霞.css')
    expect(resolveThemeSelection(true, 'default', '晚霞.css')).toBe('file:晚霞.css')
    expect(resolveThemeSelection(false, 'sepia', '晚霞.css')).toBe('file:晚霞.css')
  })

  it('内置体系：default + 深色 → dark 项', () => {
    expect(resolveThemeSelection(true, 'default', '')).toBe('dark')
  })

  it('内置体系：default + 浅色 → default 项', () => {
    expect(resolveThemeSelection(false, 'default', '')).toBe('default')
  })

  it('内置预设项原样返回（sepia/green 不看深浅）', () => {
    expect(resolveThemeSelection(false, 'sepia', '')).toBe('sepia')
    expect(resolveThemeSelection(true, 'green', '')).toBe('green')
  })
})

describe('parseThemeRadioValue', () => {
  it('文件主题项还原为裸文件名', () => {
    expect(parseThemeRadioValue('file:晚霞.css')).toBe('晚霞.css')
  })

  it('内置项返回 null', () => {
    expect(parseThemeRadioValue('dark')).toBeNull()
    expect(parseThemeRadioValue('default')).toBeNull()
    expect(parseThemeRadioValue('sepia')).toBeNull()
  })
})

describe('displayThemeName', () => {
  it('去掉 .css 扩展名（大小写不敏感）', () => {
    expect(displayThemeName('晚霞.css')).toBe('晚霞')
    expect(displayThemeName('night.CSS')).toBe('night')
  })
})

describe('FILE_THEME_PREFIX', () => {
  it('前缀为 file:', () => {
    expect(FILE_THEME_PREFIX).toBe('file:')
  })
})
