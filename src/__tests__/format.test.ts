import { describe, it, expect } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import type { Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { Command } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { MENU_COMMANDS, toggleBlockquote, toggleList } from '../format'

// 与 Milkdown commonmark/gfm 同名的最小 schema，验证命令行为
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'block+' },
    text: { group: 'inline' },
  },
  marks: { strong: {}, highlight: {}, superscript: {}, subscript: {} },
})

const doc = (...blocks: Node[]) => schema.node('doc', null, blocks)
const p = (text = '') => schema.node('paragraph', null, text ? [schema.text(text)] : [])

/** 执行命令（dispatch 捕获事务，不落地），返回是否成功与结果事务 */
function run(cmd: Command, state: EditorState): { ok: boolean; tr: Transaction | null } {
  let tr: Transaction | null = null
  const ok = cmd(state, (t) => {
    tr = t
  })
  return { ok, tr }
}

describe('块级格式切换命令', () => {
  it('toggleBlockquote 把段落包进引用', () => {
    const state = EditorState.create({ doc: doc(p('hello')) })
    const { ok, tr } = run(toggleBlockquote, state)
    expect(ok).toBe(true)
    expect(tr?.doc.firstChild?.type.name).toBe('blockquote')
  })

  it('引用内再按一次退出引用', () => {
    const state = EditorState.create({ doc: doc(schema.node('blockquote', null, [p('hello')])) })
    const { ok, tr } = run(toggleBlockquote, state)
    expect(ok).toBe(true)
    expect(tr?.doc.firstChild?.type.name).toBe('paragraph')
  })

  it('toggleList 包成无序列表，再按一次退出', () => {
    const state = EditorState.create({ doc: doc(p('item')) })
    const first = run(toggleList('bullet_list'), state)
    expect(first.ok).toBe(true)
    const list = first.tr?.doc.firstChild
    expect(list?.type.name).toBe('bullet_list')
    expect(list?.firstChild?.type.name).toBe('list_item')

    const second = run(toggleList('bullet_list'), state.apply(first.tr!))
    expect(second.ok).toBe(true)
    expect(second.tr?.doc.firstChild?.type.name).toBe('paragraph')
  })

  it('Cmd+A 全选（$from 在 doc 层）再按一次仍能退出列表', () => {
    const wrapped = doc(
      schema.node('bullet_list', null, [schema.node('list_item', null, [p('item')])]),
    )
    // 全选：选区从文档头（depth 0）到文档尾
    const state = EditorState.create({
      doc: wrapped,
      selection: TextSelection.create(wrapped, 0, wrapped.content.size),
    })
    const { ok, tr } = run(toggleList('bullet_list'), state)
    expect(ok).toBe(true)
    expect(tr?.doc.firstChild?.type.name).toBe('paragraph')
  })

  it('fmt-h2 把段落转为二级标题', () => {
    const state = EditorState.create({ doc: doc(p('title')) })
    // MENU_COMMANDS 只读 state.schema，传最小桩即可
    const cmd = MENU_COMMANDS['fmt-h2']({ state } as unknown as EditorView)
    const { ok, tr } = run(cmd, state)
    expect(ok).toBe(true)
    expect(tr?.doc.firstChild?.type.name).toBe('heading')
    expect(tr?.doc.firstChild?.attrs.level).toBe(2)
  })

  it.each([
    ['fmt-mark', 'highlight'],
    ['fmt-sup', 'superscript'],
    ['fmt-sub', 'subscript'],
  ] as const)('%s 给选区加标记，再执行一次移除', (action, markName) => {
    const node = p('abc')
    let state = EditorState.create({
      doc: doc(node),
      selection: TextSelection.create(doc(node), 1, 3),
    })
    const cmd = () => MENU_COMMANDS[action]({ state } as unknown as EditorView)
    const first = run(cmd(), state)
    expect(first.ok).toBe(true)
    expect(first.tr?.doc.textBetween(0, 5)).toBe('abc')
    const marked = first.tr!.doc.firstChild!.firstChild!
    expect(marked.marks.map((m) => m.type.name)).toContain(markName)

    // 同一选区再执行一次：标记移除
    state = state.apply(first.tr!)
    const second = run(cmd(), state)
    expect(second.ok).toBe(true)
    expect(second.tr!.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).not.toContain(
      markName,
    )
  })
})
