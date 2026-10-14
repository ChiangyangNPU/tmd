import { describe, it, expect } from 'vitest'
import { classifyDroppedFiles } from '../dragdrop'

const file = (name: string, type = ''): File => new File([''], name, { type })

describe('classifyDroppedFiles', () => {
  it('markdown 与 txt 文件按扩展名识别（大小写不敏感）', () => {
    const { markdown } = classifyDroppedFiles([file('a.md'), file('B.MARKDOWN'), file('c.TXT')])
    expect(markdown.map((f) => f.name)).toEqual(['a.md', 'B.MARKDOWN', 'c.TXT'])
  })

  it('图片按 MIME 类型识别', () => {
    const { images } = classifyDroppedFiles([
      file('a.png', 'image/png'),
      file('b.gif', 'image/gif'),
    ])
    expect(images).toHaveLength(2)
  })

  it('其他文件忽略', () => {
    const r = classifyDroppedFiles([
      file('a.json', 'application/json'),
      file('b.pdf', 'application/pdf'),
    ])
    expect(r.markdown).toHaveLength(0)
    expect(r.images).toHaveLength(0)
  })

  it('混合拖入各自归类；.md 且声明图片类型的以扩展名优先', () => {
    const r = classifyDroppedFiles([
      file('doc.md', 'text/markdown'),
      file('pic.png', 'image/png'),
      file('skip.exe'),
    ])
    expect(r.markdown.map((f) => f.name)).toEqual(['doc.md'])
    expect(r.images.map((f) => f.name)).toEqual(['pic.png'])
  })
})
