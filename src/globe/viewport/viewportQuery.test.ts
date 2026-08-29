import { describe, it, expect, vi, afterEach } from 'vitest'
import { queryViewportData } from './viewportQuery'
import { resolveFeatureQueryBase, resolveFeatureService } from './featureQuery'

describe('queryViewportData', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按视口查询并返回预算后的 features', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/FeatureServer?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 1 }] }) }
      expect(u).toMatch(/geometry=1%2C2%2C3%2C4|geometry=1,2,3,4/)
      expect(u).toMatch(/FeatureServer\/1\/query/)
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

  it('json 解析失败时回退空 features', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } })))
    const r = await queryViewportData('https://x/svc', { west: 0, south: 0, east: 1, north: 1 })
    expect(r.features.length).toBe(0)
  })
})

describe('resolveFeatureQueryBase', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('根 FeatureServer 探测第一个可查询层 id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ layers: [{ id: 1 }] }) })))
    expect(await resolveFeatureQueryBase('https://a/FeatureServer')).toBe('https://a/FeatureServer/1')
  })

  it('已带层号的地址保持原样', async () => {
    expect(await resolveFeatureQueryBase('https://b/FeatureServer/5')).toBe('https://b/FeatureServer/5')
  })

  it('探测失败回退 /0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await resolveFeatureQueryBase('https://c/FeatureServer')).toBe('https://c/FeatureServer/0')
  })
})


describe('resolveFeatureService', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('服务根返回全部层 + 数据范围', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ layers: [{ id: 1 }, { id: 2 }], fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 }, spatialReference: { wkid: 4326 } }) })))
    const svc = await resolveFeatureService('https://a/FeatureServer')
    expect(svc.layers).toEqual(['https://a/FeatureServer/1', 'https://a/FeatureServer/2'])
    expect(svc.extent).toEqual({ west: -180, south: -90, east: 180, north: 90, wkid: 4326 })
  })

  it('已带层号只返回该层且不请求', async () => {
    const svc = await resolveFeatureService('https://b/FeatureServer/3')
    expect(svc.layers).toEqual(['https://b/FeatureServer/3'])
    expect(svc.extent).toBeUndefined()
  })

  it('探测失败回退 /0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect((await resolveFeatureService('https://c/FeatureServer')).layers).toEqual(['https://c/FeatureServer/0'])
  })
})
