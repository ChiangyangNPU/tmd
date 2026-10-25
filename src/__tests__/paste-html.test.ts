import { describe, it, expect } from 'vitest'
import { isSafeHref, isSafeImageSrc } from '../paste-html'

describe('isSafeHref（链接协议白名单）', () => {
  it('放行 http/https/mailto 与相对路径', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('HTTP://example.com')).toBe(true)
    expect(isSafeHref('mailto:a@b.com')).toBe(true)
    expect(isSafeHref('./docs/a.md')).toBe(true)
    expect(isSafeHref('a.html#frag')).toBe(true)
  })

  it('拦截 javascript:/data:/vbscript: 等危险协议', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JAVASCRIPT:x')).toBe(false)
    expect(isSafeHref('data:text/html,<script>1</script>')).toBe(false)
    expect(isSafeHref('vbscript:x')).toBe(false)
    expect(isSafeHref('file:///etc/passwd')).toBe(false)
  })

  it('空地址拦截', () => {
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref('   ')).toBe(false)
  })
})

describe('isSafeImageSrc（图片地址白名单）', () => {
  it('放行 http/https/data:image 与相对路径', () => {
    expect(isSafeImageSrc('https://a.com/b.png')).toBe(true)
    expect(isSafeImageSrc('data:image/png;base64,AAAA')).toBe(true)
    expect(isSafeImageSrc('./assets/a.png')).toBe(true)
  })

  it('拦截非 image 的 data: 与危险协议', () => {
    expect(isSafeImageSrc('data:text/html,<script>1</script>')).toBe(false)
    expect(isSafeImageSrc('javascript:x')).toBe(false)
    expect(isSafeImageSrc('')).toBe(false)
  })
})
