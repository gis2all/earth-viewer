import { describe, it, expect } from 'vitest'
import { createLru, viewportCacheKey } from './lru'

describe('createLru', () => {
  it('命中后移到末尾，超容量淘汰最久未用', () => {
    const c = createLru<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // a 移到最近
    c.set('c', 3) // 容量满，淘汰最久未用的 b
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
    expect(c.size()).toBe(2)
  })

  it('set 已存在 key 会刷新次序', () => {
    const c = createLru<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 10)
    c.set('c', 3)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(10)
  })

  it('delete 与 size', () => {
    const c = createLru<string, number>(3)
    c.set('a', 1)
    c.delete('a')
    expect(c.size()).toBe(0)
  })
})

describe('viewportCacheKey', () => {
  it('量化视口生成稳定 key', () => {
    expect(viewportCacheKey({ west: 1.1, south: 2.1, east: 3.1, north: 4.1 }, 0.5)).toBe('2,4,6,8')
    expect(viewportCacheKey({ west: 1.11, south: 2.11, east: 3.11, north: 4.11 }, 0.5)).toBe('2,4,6,8')
  })
})
