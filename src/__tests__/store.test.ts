import { describe, it, expect, beforeEach } from 'vitest'
import {
  saveDoc,
  loadDoc,
  clearDoc,
  getTheme,
  setTheme,
  recentList,
  pushRecent,
  clearRecent,
  removeRecent,
  folderList,
  pushFolder,
  clearFolders,
  removeFolder,
  getImageStrategy,
  setImageStrategy,
  getAutosaveEnabled,
  setAutosaveEnabled,
} from '../store'

/** 简单内存版 localStorage（每个用例重置） */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage() as unknown as Storage
})

describe('store', () => {
  it('文档恢复副本存取', () => {
    expect(loadDoc()).toBeNull()
    saveDoc('内容')
    expect(loadDoc()).toBe('内容')
    clearDoc()
    expect(loadDoc()).toBeNull()
  })

  it('主题偏好', () => {
    expect(getTheme()).toBe('light')
    setTheme(true)
    expect(getTheme()).toBe('dark')
  })

  it('最近列表：去重置顶、最多 8 条', () => {
    pushRecent('/a.md', 'a')
    pushRecent('/b.md', 'b')
    pushRecent('/a.md', 'a')
    expect(recentList()).toEqual([
      { path: '/a.md', name: 'a' },
      { path: '/b.md', name: 'b' },
    ])
    for (let i = 0; i < 10; i++) pushRecent(`/f${i}.md`, `f${i}`)
    expect(recentList()).toHaveLength(8)
    expect(recentList()[0]).toEqual({ path: '/f9.md', name: 'f9' })
  })

  it('损坏的最近列表 JSON 返回空数组', () => {
    localStorage.setItem('tmd:recent', '{broken')
    expect(recentList()).toEqual([])
  })

  it('清空最近列表', () => {
    pushRecent('/a.md', 'a')
    clearRecent()
    expect(recentList()).toEqual([])
    // 对空列表再次清空不报错
    clearRecent()
    expect(recentList()).toEqual([])
  })

  it('移除单条：其余顺序保留，不存在的路径静默忽略', () => {
    pushRecent('/a.md', 'a')
    pushRecent('/b.md', 'b')
    pushRecent('/c.md', 'c')
    removeRecent('/b.md')
    expect(recentList()).toEqual([
      { path: '/c.md', name: 'c' },
      { path: '/a.md', name: 'a' },
    ])
    removeRecent('/not-exist.md')
    expect(recentList()).toHaveLength(2)
  })

  it('文件夹列表：追加去重、保持打开顺序', () => {
    pushFolder('/dir-a', 'a')
    pushFolder('/dir-b', 'b')
    // 同路径重复追加不改变顺序、不产生重复
    pushFolder('/dir-a', 'a')
    expect(folderList()).toEqual([
      { path: '/dir-a', name: 'a' },
      { path: '/dir-b', name: 'b' },
    ])
  })

  it('损坏的文件夹列表 JSON 返回空数组', () => {
    localStorage.setItem('tmd:folders', '{broken')
    expect(folderList()).toEqual([])
  })

  it('清空文件夹列表（不影响最近文件）', () => {
    pushFolder('/dir-a', 'a')
    pushRecent('/a.md', 'a')
    clearFolders()
    expect(folderList()).toEqual([])
    expect(recentList()).toHaveLength(1)
    // 对空列表再次清空不报错
    clearFolders()
    expect(folderList()).toEqual([])
  })

  it('移除单个文件夹：其余顺序保留，不存在的路径静默忽略', () => {
    pushFolder('/dir-a', 'a')
    pushFolder('/dir-b', 'b')
    pushFolder('/dir-c', 'c')
    removeFolder('/dir-b')
    expect(folderList()).toEqual([
      { path: '/dir-a', name: 'a' },
      { path: '/dir-c', name: 'c' },
    ])
    removeFolder('/not-exist')
    expect(folderList()).toHaveLength(2)
  })

  it('图片策略与自动保存开关', () => {
    expect(getImageStrategy()).toBe('inline')
    setImageStrategy('assets')
    expect(getImageStrategy()).toBe('assets')
    expect(getAutosaveEnabled()).toBe(false)
    setAutosaveEnabled(true)
    expect(getAutosaveEnabled()).toBe(true)
  })
})
