import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOgcFeatureGeoJSON } from './ogc'

describe('fetchOgcFeatureGeoJSON', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('直接读取 OGC API Features 的 GeoJSON', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return {
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: null, properties: { id: 1 } }],
        }),
      }
    }))

    const result = await fetchOgcFeatureGeoJSON('https://example.test/collections/roads/items')

    expect(result).toEqual(expect.objectContaining({ type: 'FeatureCollection' }))
    expect(urls[0]).toContain('f=geojson')
    expect(urls[0]).toContain('limit=3000')
  })

  it('从 OGC API Features collections 发现集合后读取 items', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/collections?')) {
        return { ok: true, json: async () => ({ collections: [{ id: 'roads' }] }) }
      }
      return {
        ok: true,
        json: async () => ({ type: 'FeatureCollection', features: [] }),
      }
    }))

    await fetchOgcFeatureGeoJSON('https://example.test/ogc')

    expect(urls.some((url) => url.includes('/collections/roads/items'))).toBe(true)
  })

  it('读取 WFS GetCapabilities 的第一个要素类型，再请求 GeoJSON', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('GetCapabilities')) {
        return {
          ok: true,
          text: async () => `
            <WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0">
              <wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>roads</wfs:Name></wfs:FeatureType></wfs:FeatureTypeList>
            </WFS_Capabilities>
          `,
        }
      }
      return {
        ok: true,
        json: async () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {} }] }),
      }
    }))

    const result = await fetchOgcFeatureGeoJSON('https://example.test/wfs', { type: 'WFS' })

    expect(result).toEqual(expect.objectContaining({ type: 'FeatureCollection' }))
    const getFeature = urls.find((url) => url.includes('GetFeature'))
    expect(getFeature).toContain('typeNames=roads')
    expect(getFeature).toContain('outputFormat=application%2Fjson')
  })

  it('WFS 优先使用 WebMap 指定的 layerName', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('GetCapabilities')) {
        return { ok: true, text: async () => '<WFS_Capabilities />' }
      }
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }
    }))

    await fetchOgcFeatureGeoJSON('https://example.test/wfs', { type: 'WFS', layerName: 'buildings' })

    expect(urls.some((url) => url.includes('typeNames=buildings'))).toBe(true)
  })
})

  it('WFS GetCapabilities 非 ok → 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(fetchOgcFeatureGeoJSON('https://x/wfs', { type: 'WFS' })).rejects.toThrow('GetCapabilities')
  })

  it('WFS 未找到要素类型→ 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<WFS_Capabilities />' })))
    await expect(fetchOgcFeatureGeoJSON('https://x/wfs', { type: 'WFS' })).rejects.toThrow('未找到')
  })

  it('WFS 返回非 GeoJSON → 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('GetCapabilities')) return { ok: true, text: async () => '<WFS><Name>r</Name></WFS>' }
      return { ok: true, json: async () => ({ type: 'NotFC' }) }
    }))
    await expect(fetchOgcFeatureGeoJSON('https://x/wfs', { type: 'WFS' })).rejects.toThrow('未返回 GeoJSON')
  })

  it('读取 OGC /collections/xxx 路径', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }
    }))
    await fetchOgcFeatureGeoJSON('https://x/collections/roads')
    expect(urls.some((u) => u.includes('/collections/roads/items'))).toBe(true)
  })

  it('传入 collectionId 时走 /collections/<id> 分支', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }
    }))
    await fetchOgcFeatureGeoJSON('https://x/ogc', { collectionId: 'bldg' })
    expect(urls.some((u) => u.includes('/collections/bldg/items'))).toBe(true)
  })

  it('OGC collections 无 id → 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ collections: [{ name: 'no-id' }] }) })))
    await expect(fetchOgcFeatureGeoJSON('https://x/ogc')).rejects.toThrow('未找到要素集合')
  })

  it('OGC 请求非 ok → 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(fetchOgcFeatureGeoJSON('https://x/ogc')).rejects.toThrow('请求失败')
  })

  it('readJson JSON 解析失败回退 reject', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } })))
    await expect(fetchOgcFeatureGeoJSON('https://x/ogc')).rejects.toThrow('bad json')
  })
