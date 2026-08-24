import { describe, it, expect, vi, afterEach } from 'vitest'
import { queryViewportData } from './query'

describe('queryViewportData', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按视口查询并返回预算后的 features', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toMatch(/geometry=1%2C2%2C3%2C4|geometry=1,2,3,4/)
      return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [0, 0] } }] }) }
    }))
    const r = await queryViewportData('https://x/FeatureServer', { west: 1, south: 2, east: 3, north: 4 }, { maxVertices: 100, maxFeatures: 100 })
    expect(r.features.length).toBe(1)
    expect(r.vertices).toBe(1)
  })

  it('非 ok 响应抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(queryViewportData('https://x/svc', { west: 0, south: 0, east: 1, north: 1 })).rejects.toThrow()
  })
})

  it('json 解析失败时回退空 features', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } })))
    const r = await queryViewportData('https://x/svc', { west: 0, south: 0, east: 1, north: 1 })
    expect(r.features.length).toBe(0)
  })
