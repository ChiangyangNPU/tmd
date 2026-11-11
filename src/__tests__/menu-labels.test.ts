/**
 * 菜单文案单源校验。
 *
 * Rust 侧不再内置任何语言的菜单文案（原先 menu.rs 的 DEFAULT_MENU_LABELS 已删），
 * 文案全部由渲染层的 menuLabels() 经 set_locale_info 传入。这条约束只有靠测试
 * 才能守住：扫描 menu.rs 的文案取值调用，断言每个 key 都能在 menuLabels 里找到，
 * 且其指向的语言键在三个语言包中都存在——新增菜单项若忘加文案会直接挂在这里，
 * 而不是等到真机菜单显示英文 key。
 *
 * @author chiangyang
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const menuRs = readFileSync(resolve(root, 'src-tauri/src/menu.rs'), 'utf8')
const i18nTs = readFileSync(resolve(root, 'src/i18n.ts'), 'utf8')

/** menu.rs 里以字面量取文案的所有 key（动态拼接的 h1~h6 另行覆盖） */
function usedMenuKeys(): string[] {
  const keys = new Set<string>()
  for (const m of menuRs.matchAll(/\bl\("([A-Za-z][A-Za-z0-9]*)"\)/g)) keys.add(m[1])
  return [...keys].sort()
}

/** i18n.ts 的 menuLabels() 返回表：菜单 key → 语言包键（menu.xxx） */
function labelMap(): Map<string, string> {
  const start = i18nTs.indexOf('export function menuLabels')
  expect(start).toBeGreaterThan(-1)
  const end = i18nTs.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  const body = i18nTs.slice(start, end)
  const map = new Map<string, string>()
  for (const m of body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*t\('([A-Za-z0-9_.]+)'\)/gm)) {
    map.set(m[1], m[2])
  }
  return map
}

const locales = ['zh-CN', 'zh-Hant', 'en'].map((name) => ({
  name,
  data: JSON.parse(readFileSync(resolve(root, `src/locales/${name}.json`), 'utf8')) as {
    menu?: Record<string, string>
  },
}))

describe('菜单文案单源', () => {
  const map = labelMap()

  it('menu.rs 的每个文案 key 都能在 menuLabels 中找到', () => {
    const missing = usedMenuKeys().filter((key) => !map.has(key))
    expect(missing, `这些 key 在 src/i18n.ts 的 menuLabels 中缺失`).toEqual([])
  })

  it('动态拼接的标题级别 key（h1~h6）也在表中', () => {
    for (let level = 1; level <= 6; level++) {
      expect(map.has(`h${level}`), `缺 h${level}`).toBe(true)
    }
  })

  it.each(locales)('menuLabels 指向的语言键在 $name 语言包里都存在', ({ name, data }) => {
    const missing = [...map.values()].filter((i18nKey) => {
      const [section, key] = i18nKey.split('.')
      return section !== 'menu' || !data.menu?.[key]
    })
    expect(missing, `${name}.json 的 menu 段缺键`).toEqual([])
  })
})
