import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchUserHome, getUserHome, resetUserHomeCache } from './userLocation'

describe('geo (用户大概定位)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetUserHomeCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('/api/geo 成功 → 返回经纬度并缓存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ lat: 31, lon: 121, country: 'CN' }) })))
    const home = await fetchUserHome()
    expect(home).toEqual({ lat: 31, lon: 121 })
    expect(getUserHome()).toEqual({ lat: 31, lon: 121 })
    // 已有缓存 → 不再发起请求
    await fetchUserHome()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('/api/geo 失败/404 → 回退硬编码 (35, 104)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    const home = await fetchUserHome()
    expect(home).toEqual({ lat: 35, lon: 104 })
  })

  it('/api/geo 抛错 → 回退硬编码 (35, 104)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('boom') }))
    const home = await fetchUserHome()
    expect(home).toEqual({ lat: 35, lon: 104 })
  })

  it('内存缓存优先，即便 localStorage 有值也先读内存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ lat: 39, lon: 116 }) })))
    await fetchUserHome()
    expect(getUserHome()).toEqual({ lat: 39, lon: 116 })
  })

  it('localStorage 有合法缓存 → resetUserHomeCache 后直接读内存', () => {
    localStorage.setItem('earth-viewer:userHome', JSON.stringify({ lat: 23, lon: 113 }))
    resetUserHomeCache()
    expect(getUserHome()).toEqual({ lat: 23, lon: 113 })
  })

  it('localStorage 为非法 JSON → resetUserHomeCache 回退并忽略', async () => {
    localStorage.setItem('earth-viewer:userHome', 'not-json')
    resetUserHomeCache()
    expect(getUserHome()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await fetchUserHome()).toEqual({ lat: 35, lon: 104 })
  })
})
