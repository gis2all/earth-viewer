import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildSearchQuery,
  mergeSearchResults,
  fetchSearchPage,
  fetchItemMetadata,
  readPreflightCache,
  writePreflightCache,
  preflightService,
  preflightItem,
  fetchWebmap,
  detectMapService,
  clearCrsCache,
  fetchFeatureGeoJSON,
  fetchFeatureRenderer,
  fetchServiceGeoExtent,
  fetchSceneLayerKinds,
  isPointCloudScene,
  fetchSceneExtent,
} from './repository'

describe('repository 搜索查询（W2.1）', () => {
  it('buildSearchQuery 带权威过滤与公开条件', () => {
    const q = buildSearchQuery('Web Map', '')
    expect(q).toContain('type:"Web Map"')
    expect(q).toContain('access:public')
    expect(q).toContain('contentstatus:"org_authoritative"')
    expect(q).toContain('NOT contentstatus:"deprecated"')
  })

  it('关键词直接拼接；OR 关键词整体加括号', () => {
    expect(buildSearchQuery('Web Map', 'imagery')).toContain(' AND (imagery)')
    expect(buildSearchQuery('Web Map', 'roads OR streets')).toContain(' AND (roads OR streets)')
  })

  it('mergeSearchResults 按 id 去重并按 numViews 降序', () => {
    const merged = mergeSearchResults([
      [{ id: 'a', title: 'A', numViews: 1 }, { id: 'b', title: 'B', numViews: 2 }],
      [{ id: 'a', title: 'A dup', numViews: 9 }, { id: 'c', title: 'C', numViews: 3 }],
    ])
    expect(merged.map((x) => x.id)).toEqual(['c', 'b', 'a'])
    expect(merged[2].title).toBe('A')
  })

  it('fetchSearchPage 拉取并映射字段，透传 nextStart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        expect(u).toContain('/sharing/rest/search')
        expect(u).toContain('num=12')
        expect(u).toContain('start=1')
        return {
          ok: true,
          json: async () => ({
            results: [{ id: 'x1', title: 'T', thumbnail: 't.png', numViews: 5, url: 'u', type: 'Web Map', contentStatus: 'public_authoritative' }],
            nextStart: 13,
          }),
        }
      })
    )
    const page = await fetchSearchPage('Web Map', '', 1)
    expect(page.results[0]).toMatchObject({ id: 'x1', title: 'T', thumbnail: 't.png', numViews: 5 })
    expect(page.nextStart).toBe(13)
    vi.unstubAllGlobals()
  })

  it('fetchSearchPage HTTP 失败抛 ArcGIS 搜索失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    await expect(fetchSearchPage('Web Map', '', 1)).rejects.toThrow('ArcGIS 搜索失败')
    vi.unstubAllGlobals()
  })
})

describe('repository item 元数据（W2.1）', () => {
  it('fetchItemMetadata 读取 contentStatus 与 groupDesignations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ contentStatus: 'org_authoritative', groupDesignations: ['livingatlas'] }) })))
    await expect(fetchItemMetadata('abc')).resolves.toEqual({ contentStatus: 'org_authoritative', groupDesignations: ['livingatlas'] })
    vi.unstubAllGlobals()
  })

  it('元数据含 error / 请求失败 / 字段缺失 → null 或 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: { code: 403 } }) })))
    await expect(fetchItemMetadata('bad')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    await expect(fetchItemMetadata('bad')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: 'no status' }) })))
    await expect(fetchItemMetadata('plain')).resolves.toEqual({ contentStatus: undefined, groupDesignations: undefined })
    vi.unstubAllGlobals()
  })
})

describe('repository 预检缓存（W2.1）', () => {
  beforeEach(() => localStorage.clear())

  it('写入可读回；过期条目被过滤', () => {
    const map = new Map<string, { s: 'ok' | 'bad'; t: number }>([
      ['ok1', { s: 'ok', t: Date.now() }],
      ['old', { s: 'bad', t: Date.now() - 25 * 60 * 60 * 1000 }],
    ])
    writePreflightCache(map)
    const read = readPreflightCache()
    expect(read.has('ok1')).toBe(true)
    expect(read.has('old')).toBe(false)
  })

  it('损坏 JSON / 非法状态 → 空 Map', () => {
    localStorage.setItem('earth-viewer:preflight', '{bad')
    expect(readPreflightCache().size).toBe(0)
    localStorage.setItem('earth-viewer:preflight', JSON.stringify({ x: { s: 'weird', t: Date.now() } }))
    expect(readPreflightCache().size).toBe(0)
  })

  it('preflightService：可用 true；error / 非 ok / 网络异常 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ currentVersion: 10.3 }) })))
    await expect(preflightService('https://s/MapServer')).resolves.toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: { code: 499 } }) })))
    await expect(preflightService('https://s/MapServer')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))
    await expect(preflightService('https://s/MapServer')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net') }))
    await expect(preflightService('https://s/MapServer')).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('preflightItem：容器走 data；服务走服务根；无 url 直接可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/items/wm1/data')) return { ok: true, json: async () => ({ baseMap: {} }) }
      if (u.includes('/items/scene1/data')) return { ok: true, json: async () => ({ error: { code: 400 } }) }
      if (u.includes('/rest/services')) return { ok: true, json: async () => ({ currentVersion: 1 }) }
      return { ok: false, status: 404 }
    }))
    await expect(preflightItem({ id: 'wm1', type: 'Web Map', url: undefined })).resolves.toBe(true)
    await expect(preflightItem({ id: 'scene1', type: 'Web Scene', url: undefined })).resolves.toBe(false)
    await expect(preflightItem({ id: 'svc', type: 'Map Service', url: 'https://s/rest/services/X/MapServer' })).resolves.toBe(true)
    await expect(preflightItem({ id: 'file', type: 'GeoJson', url: undefined })).resolves.toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('repository fetchWebmap（W2.1）', () => {
  it('成功拉取 webmap JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: 'wm' }) })))
    await expect(fetchWebmap('abc')).resolves.toEqual({ title: 'wm' })
    vi.unstubAllGlobals()
  })

  it('HTTP 失败抛获取 Web Map 失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    await expect(fetchWebmap('abc')).rejects.toThrow('获取 Web Map 失败')
    vi.unstubAllGlobals()
  })
})

describe('repository detectMapService（W2.1）', () => {
  beforeEach(() => clearCrsCache())

  it('有 tileInfo → tiled=true，读取 wkid 与最大级别', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 4326 }, tileInfo: { lods: [{}, {}, {}] } }) })))
    await expect(detectMapService('https://d1/MapServer/')).resolves.toEqual({ wkid: 4326, maxLevel: 2, tiled: true })
    vi.unstubAllGlobals()
  })

  it('无 tileInfo → tiled=false（动态服务）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) })))
    await expect(detectMapService('https://d2/MapServer')).resolves.toMatchObject({ tiled: false })
    vi.unstubAllGlobals()
  })

  it('非 ok / 无 wkid → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    await expect(detectMapService('https://d3/MapServer')).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    await expect(detectMapService('https://d4/MapServer')).resolves.toBeNull()
    vi.unstubAllGlobals()
  })

  it('外部 signal 中止时探测被取消并返回 null', async () => {
    const ac = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }))
    const p = detectMapService('https://d5/MapServer', ac.signal)
    ac.abort()
    await expect(p).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})


describe('repository 服务范围（服务 extent 解析）', () => {
  beforeEach(() => clearCrsCache())

  it('detectMapService 从 fullExtent 读取四角范围', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 28992 }, fullExtent: { xmin: -271549, ymin: 227882, xmax: 508740, ymax: 665169 } }) })))
    const info = await detectMapService('https://rd/MapServer')
    expect(info).toMatchObject({ wkid: 28992, extent: { west: -271549, south: 227882, east: 508740, north: 665169 } })
    vi.unstubAllGlobals()
  })

  it('fetchServiceGeoExtent 用 outSR=4326 要素外包框求地理范围', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 0 }] }) }
      return { ok: true, json: async () => ({ features: [{ geometry: { paths: [[[-91.15, 30.45], [-91.1, 30.6]]] } }] }) }
    }))
    const ext = await fetchServiceGeoExtent('https://br/MapServer')
    expect(ext).not.toBeNull()
    expect(ext!.west).toBeCloseTo(-91.15, 4)
    expect(ext!.south).toBeCloseTo(30.45, 4)
    expect(ext!.east).toBeCloseTo(-91.1, 4)
    expect(ext!.north).toBeCloseTo(30.6, 4)
    vi.unstubAllGlobals()
  })

  it('无 fullExtent 且子层不可查询 → fetchServiceGeoExtent 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 0 }] }) }
      return { ok: false, status: 400 }
    }))
    await expect(fetchServiceGeoExtent('https://tiled/MapServer')).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})
describe('repository 要素数据（W2.1）', () => {
  it('fetchFeatureGeoJSON 分页拉取并返回 FeatureCollection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('?f=json') && !u.includes('/query')) return { ok: true, json: async () => ({ maxRecordCount: 2000, layers: [{ id: 0 }] }) }
      if (u.includes('f=geojson')) return { ok: true, json: async () => ({ features: [{ type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } }] }) }
      return { ok: false, status: 404 }
    }))
    const out = await fetchFeatureGeoJSON('https://f/FeatureServer', 10)
    expect((out as { features: unknown[] }).features).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('f=geojson 失败回退 f=json 并转换几何', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('?f=json') && !u.includes('/query')) return { ok: true, json: async () => ({ maxRecordCount: 2000, layers: [{ id: 0 }] }) }
      if (u.includes('f=geojson')) return { ok: false, status: 400 }
      return { ok: true, json: async () => ({ features: [{ attributes: { k: 'v' }, geometry: { x: 5, y: 6 } }] }) }
    }))
    const out = await fetchFeatureGeoJSON('https://f/FeatureServer', 10)
    const feats = (out as { features: Array<{ geometry: { type: string; coordinates: number[] } }> }).features
    expect(feats[0].geometry).toEqual({ type: 'Point', coordinates: [5, 6] })
    vi.unstubAllGlobals()
  })

  it('查询失败抛要素服务查询失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('?f=json') && !u.includes('/query')) return { ok: true, json: async () => ({}) }
      return { ok: false, status: 500 }
    }))
    await expect(fetchFeatureGeoJSON('https://f/FeatureServer', 10)).rejects.toThrow('要素服务查询失败')
    vi.unstubAllGlobals()
  })

  it('pageSize 大于 limit 时按剩余预算截断，不突破上限', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('?f=json') && !u.includes('/query')) return { ok: true, json: async () => ({ maxRecordCount: 2000, layers: [{ id: 0 }] }) }
      if (u.includes('f=geojson')) {
        requested.push(u)
        const params = new URL(u).searchParams
        const count = Number(params.get('resultRecordCount'))
        const offset = Number(params.get('resultOffset'))
        const feats = Array.from({ length: count }, (_, i) => ({
          type: 'Feature',
          properties: { n: offset + i },
          geometry: { type: 'Point', coordinates: [offset + i, offset + i] },
        }))
        return { ok: true, json: async () => ({ features: feats }) }
      }
      return { ok: false, status: 404 }
    }))
    const out = await fetchFeatureGeoJSON('https://f/FeatureServer', 3000)
    const feats = (out as { features: unknown[] }).features
    expect(feats).toHaveLength(3000)
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain('resultRecordCount=1000')
    vi.unstubAllGlobals()
  })

  it('fetchFeatureRenderer 读取 drawingInfo.renderer，失败返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ drawingInfo: { renderer: { type: 'simple' } } }) })))
    await expect(fetchFeatureRenderer('https://f/FeatureServer')).resolves.toEqual({ type: 'simple' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    await expect(fetchFeatureRenderer('https://f/FeatureServer')).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('repository 场景图层类型（点云屏蔽）', () => {
  it('fetchSceneLayerKinds：根 SceneServer 读 layers[].layerType', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ layers: [{ id: 0, layerType: 'Point' }] }) })))
    await expect(fetchSceneLayerKinds('https://x/SceneServer')).resolves.toEqual(['point'])
  })

  it('fetchSceneLayerKinds：SceneLayer URL 读顶层 layerType', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 0, layerType: '3DObject' }) })))
    await expect(fetchSceneLayerKinds('https://x/SceneServer/layers/0')).resolves.toEqual(['mesh'])
  })

  it('fetchSceneLayerKinds 失败或无 layers -> 空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 })))
    await expect(fetchSceneLayerKinds('https://x/SceneServer')).resolves.toEqual([])
  })

  it('isPointCloudScene 纯点云为真，含 mesh 为假', () => {
    expect(isPointCloudScene(['point'])).toBe(true)
    expect(isPointCloudScene(['point', 'unknown'])).toBe(true)
    expect(isPointCloudScene(['mesh'])).toBe(false)
    expect(isPointCloudScene(['mesh', 'point'])).toBe(false)
    expect(isPointCloudScene([])).toBe(false)
  })

describe('repository 场景 extent（独立 Scene Service 飞到数据范围）', () => {
  it('fetchSceneExtent：SceneServer 根无 fullExtent 时读第一个图层', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('/layers/0?f=json')) {
        return { ok: true, json: async () => ({ id: 0, fullExtent: { xmin: 5, ymin: 50, xmax: 7, ymax: 53 }, spatialReference: { wkid: 4326 } }) }
      }
      return { ok: true, json: async () => ({ layers: [{ id: 0, layerType: '3DObject' }] }) }
    }))
    const ext = await fetchSceneExtent('https://x/SceneServer')
    expect(ext).toEqual({ wkid: 4326, west: 5, south: 50, east: 7, north: 53 })
  })

  it('fetchSceneExtent：SceneLayer URL 直接读 fullExtent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 0, fullExtent: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 }, spatialReference: { wkid: 3857 } }) })))
    const ext = await fetchSceneExtent('https://x/SceneServer/layers/0')
    expect(ext).toEqual({ wkid: 3857, west: -10, south: -10, east: 10, north: 10 })
  })

  it('fetchSceneExtent：失败/无 fullExtent -> null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 })))
    await expect(fetchSceneExtent('https://x/SceneServer')).resolves.toBeNull()
  })
})
})
