/**
 * 图片路径解析插件的装饰状态机（§26.5 增量优化的回归保护）。
 *
 * 插件状态此前零测试，而「映射 + 变更范围局部扫描」是回归风险最高的路径。
 * 核心不变式：任意编辑序列后，增量产生的装饰集必须与按最终文档全量扫描
 * 的结果完全一致（用全新 EditorState 的 init 全量扫描作对照 oracle）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import type { Decoration } from '@milkdown/kit/prose/view'
import { createImageResolverPlugin, imageBaseDirKey, setImageBaseDir } from '../image-resolver'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    // 图片：行内原子节点（与真实 schema 一致，size 恒 1）
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
  },
  marks: { strong: {} },
})

const img = (src: string) => schema.nodes.image.create({ src })
const docOf = (...children: (ReturnType<typeof img> | string)[]) =>
  schema.node('doc', null, [
    schema.node(
      'paragraph',
      null,
      children.map((c) => (typeof c === 'string' ? schema.text(c) : c)),
    ),
  ])

/** 组装插件并读取装饰快照（节点装饰的 src 属性为私有形状，测试内断言用） */
const plugin = createImageResolverPlugin()
const decos = (state: EditorState): Decoration[] =>
  imageBaseDirKey.getState(state)?.find() ?? []
const snapshot = (state: EditorState) =>
  decos(state).map((d) => ({
    from: d.from,
    to: d.to,
    src: (d as unknown as { type: { attrs: { src?: string } } }).type.attrs?.src,
  }))

beforeEach(() => {
  // baseDir 是模块级状态：逐用例复位，避免相互污染
  setImageBaseDir(null)
})

describe('init 全量扫描', () => {
  it('无 baseDir 时不产生装饰', () => {
    const state = EditorState.create({ doc: docOf(img('assets/a.png')), plugins: [plugin] })
    expect(snapshot(state)).toEqual([])
  })

  it('只装饰相对路径图片；data:/https:/根相对路径不装饰', () => {
    setImageBaseDir('/docs')
    const state = EditorState.create({
      doc: docOf(img('assets/x.png'), img('data:image/png;base64,AA'), img('https://a/b.png'), img('/root.png')),
      plugins: [plugin],
    })
    expect(snapshot(state)).toEqual([{ from: 1, to: 2, src: 'file:///docs/assets/x.png' }])
  })

  it('文件名含空格与 # 时按 toFileUrl 规则编码', () => {
    setImageBaseDir('/docs')
    const state = EditorState.create({ doc: docOf(img('assets/my #1.png')), plugins: [plugin] })
    expect(snapshot(state)[0]?.src).toBe('file:///docs/assets/my%20%231.png')
  })
})

describe('增量映射与局部扫描', () => {
  /** 基线文档：img a [1,2) + '中间' [2,4) + img b [4,5) */
  const setup = () => {
    setImageBaseDir('/docs')
    return EditorState.create({
      doc: docOf(img('assets/a.png'), '中间', img('assets/b.png')),
      plugins: [plugin],
    })
  }

  it('纯文本输入：装饰随映射整体后移（O(图片数) 路径）', () => {
    let state = setup()
    state = state.apply(state.tr.insertText('XY', 1))
    expect(snapshot(state)).toEqual([
      { from: 3, to: 4, src: 'file:///docs/assets/a.png' },
      { from: 6, to: 7, src: 'file:///docs/assets/b.png' },
    ])
  })

  it('变更范围内新增图片：局部扫描补上装饰，范围外的不丢', () => {
    let state = setup()
    // 在两图之间的文本后（pos 4）插入新图：变更范围紧贴既有装饰 b 的左边界
    state = state.apply(state.tr.insert(4, img('assets/c.png')))
    expect(snapshot(state).map((d) => d.src)).toEqual([
      'file:///docs/assets/a.png',
      'file:///docs/assets/c.png',
      'file:///docs/assets/b.png',
    ])
  })

  it('变更范围紧贴图片节点边界：不产生重复装饰', () => {
    let state = setup()
    // 在 img a 的右边界（pos 2）插字：变更范围 [2,2] 与装饰 [1,2] 相触
    state = state.apply(state.tr.insertText('X', 2))
    const s = snapshot(state)
    expect(s).toHaveLength(2)
    expect(s.map((d) => d.src)).toEqual([
      'file:///docs/assets/a.png',
      'file:///docs/assets/b.png',
    ])
  })

  it('mark-only 事务（changedRange 为 null）保持装饰不变', () => {
    let state = setup()
    state = state.apply(state.tr.addMark(2, 4, schema.marks.strong.create()))
    expect(snapshot(state)).toEqual([
      { from: 1, to: 2, src: 'file:///docs/assets/a.png' },
      { from: 4, to: 5, src: 'file:///docs/assets/b.png' },
    ])
  })

  it('baseDir 切换（纯 meta 事务）后按新目录全量重建', () => {
    const state = setup()
    setImageBaseDir('/other')
    // 模拟 setImageBaseDir 在真实视图上派发的 meta 事务
    const next = state.apply(state.tr.setMeta(imageBaseDirKey, '/other'))
    expect(snapshot(next)).toEqual([
      { from: 1, to: 2, src: 'file:///other/assets/a.png' },
      { from: 4, to: 5, src: 'file:///other/assets/b.png' },
    ])
  })

  it('不变式：连续编辑后的增量装饰集与全量扫描一致', () => {
    let state = setup()
    state = state.apply(state.tr.insertText('X', 1))
    state = state.apply(state.tr.insert(5, img('assets/c.png')))
    state = state.apply(state.tr.delete(2, 4))
    state = state.apply(state.tr.insertText('YY', 3))
    // 对照 oracle：按最终文档全新 init（全量扫描）
    const fresh = EditorState.create({ doc: state.doc, plugins: [plugin] })
    expect(snapshot(state)).toEqual(snapshot(fresh))
  })
})
