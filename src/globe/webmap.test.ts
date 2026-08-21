import { describe, it, expect, vi, afterEach } from 'vitest'
import { isFeatureLayer, isGeoJsonLayer, isKmlLayer, fetchFeatureStyle, fetchFeatureGeoJSON } from './webmap'

// Cesium 在 node 环境不可用，mock 掉（webmap 只用到 Color / WMS provider）
vi.mock('cesium', () => ({
  Color: { fromBytes: (...args: number[]) => args },
  WebMapServiceImageryProvider: vi.fn(),
}))

describe('图层类型判断', () => {
  it('isFeatureLayer', () => {
    expect(isFeatureLayer({ layerType: 'ArcGISFeatureLayer', url: 'x' })).toBe(true)
    expect(isFeatureLayer({ layerType: 'GeoJSONLayer', url: 'x' })).toBe(false)
  })
  it('isGeoJsonLayer / isKmlLayer', () => {
    expect(isGeoJsonLayer({ layerType: 'GeoJSONLayer' })).toBe(true)
    expect(isKmlLayer({ layerType: 'KMLLayer' })).toBe(true)
  })
})

describe('fetchFeatureStyle（SimpleRenderer 符号映射）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('点符号 → marker 样式', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSMS', color: [255, 0, 0, 255], size: 8 } } } }),
    })))
    const style = await fetchFeatureStyle('https://x/FeatureServer/0')
    expect(style).not.toBeNull()
    expect(style?.markerSize).toBe(8)
  })

  it('面符号 → fill + outline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSFS', color: [0, 128, 255, 200], outline: { color: [0, 0, 0, 255], width: 1 } } } } }),
    })))
    const style = await fetchFeatureStyle('https://x/FeatureServer/0')
    expect(style?.fill).toBeDefined()
    expect(style?.strokeWidth).toBe(1)
  })

  it('非 simple renderer → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'uniqueValue' } } }),
    })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
  })

  it('请求失败 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
  })
})

describe('WMS provider 构造', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('图层名从 layers 数组首项提取', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wmsCtor = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    const { providerForWebLayer } = await import('./webmap')
    await providerForWebLayer({ url: 'https://x/wms', type: 'WMS', layers: [{ name: 'layerA', title: 'A' }] })
    expect(wmsCtor).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x/wms', layers: 'layerA' })
    )
  })

  it('按 resultOffset 分页拉取直到拉完或达上限', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(String(u))
        if (String(u).endsWith('?f=json')) {
          return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
        }
        const m = /resultOffset=(\d+)/.exec(String(u))
        const n = m ? Number(m[1]) : 0
        const features = n >= 3000 ? [] : Array.from({ length: 1000 }, (_, i) => ({ id: n + i }))
        return { ok: true, json: async () => ({ features }) }
      })
    )
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0', 3000)) as { features: { id: number }[] }
    expect(gj.features.length).toBe(3000)
    expect(urls.some((u) => u.includes('resultOffset=2000'))).toBe(true)
  })

  it('服务不支持分页（返回数量不变）时停止，避免死循环', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
        return { ok: true, json: async () => ({ features: [{ id: 1 }] }) }
      })
    )
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0')) as { features: unknown[] }
    expect(gj.features.length).toBe(1)
  })

  it('服务忽略 resultOffset 返回相同满页数据时停止（重复检测），不重复拉取', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        calls++
        if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
        // 每页都返回同一批 1000 条（模拟服务忽略 resultOffset）
        return {
          ok: true,
          json: async () => ({ features: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'same' })) }),
        }
      })
    )
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0', 5000)) as { features: unknown[] }
    // 重复检测应在第 2 页停止，只保留 1 页数据
    expect(gj.features.length).toBe(1000)
    expect(calls).toBeLessThan(5)
  })

  it('无图层名 → 返回 null（不构造 provider）', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wmsCtor = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wmsCtor.mockClear()
    const { providerForWebLayer } = await import('./webmap')
    const p = await providerForWebLayer({ url: 'https://x/wms', type: 'WMS' })
    expect(p).toBeNull()
    expect(wmsCtor).not.toHaveBeenCalled()
  })
})
