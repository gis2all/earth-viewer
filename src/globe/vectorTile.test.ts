import { describe, it, expect, vi, afterEach } from 'vitest'
import { decodeVectorTileLayers, vectorTileUrl, fetchVectorTileGeoJSON, fetchVectorTileTemplates, toCesiumMvtTemplate, applyVectorTileMemoryLimit } from './vectorTile'

vi.mock('@mapbox/vector-tile', () => ({
  VectorTile: vi.fn(function (this: { layers: unknown }, _pbf: unknown) {
    this.layers = {
      roads: {
        length: 1,
        feature: () => ({
          type: 1,
          properties: { name: 'road' },
          toGeoJSON: () => ({ geometry: { type: 'Point', coordinates: [116, 39] } }),
        }),
      },
    }
  }),
}))

vi.mock('pbf', () => ({
  PbfReader: vi.fn(),
}))

// 构造一个假 VectorTile（避免真实 pbf 二进制）
function fakeTile(features: { type: number; props?: Record<string, unknown>; geom?: unknown }[]) {
  return {
    layers: {
      roads: {
        length: features.length,
        feature: (i: number) => ({
          type: features[i].type,
          properties: features[i].props,
          toGeoJSON: (_x: number, _y: number, _z: number) => ({ geometry: features[i].geom }),
        }),
      },
    },
  }
}

describe('decodeVectorTileLayers', () => {
  it('把瓦片要素解码为 Feature 列表，geometry 转成经纬度', () => {
    const tile = fakeTile([{ type: 1, props: { name: 'a' }, geom: { type: 'Point', coordinates: [0, 0] } }])
    const feats = decodeVectorTileLayers(tile as never, 1, 2, 3)
    expect(feats).toHaveLength(1)
    expect(feats[0].layerName).toBe('roads')
    expect(feats[0].properties).toEqual({ name: 'a' })
    expect(feats[0].geometry).toEqual({ type: 'Point', coordinates: [0, 0] })
  })
  it('无 properties 时回退为空对象', () => {
    const tile = fakeTile([{ type: 1, geom: { type: 'Point', coordinates: [0, 0] } }])
    const feats = decodeVectorTileLayers(tile as never)
    expect(feats[0].properties).toEqual({})
  })
})

describe('vectorTileUrl', () => {
  it('拼出 /tile/{z}/{y}/{x}.pbf', () => {
    expect(vectorTileUrl('https://x/VectorTileServer', 3, 4, 5)).toBe('https://x/VectorTileServer/tile/3/4/5.pbf')
  })
})

describe('fetchVectorTileTemplates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('从 ArcGIS VectorTileServer URL 生成 Cesium MVT 模板', async () => {
    const result = await fetchVectorTileTemplates({ url: 'https://x/VectorTileServer' })
    expect(result).toEqual(['https://x/VectorTileServer/tile/{z}/{y}/{x}.pbf'])
  })

  it('从 WebScene styleUrl 的 sources 提取多个瓦片源', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sources: {
          one: { url: 'https://x/VectorTileServer' },
          two: { tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] },
        },
      }),
    })))
    const result = await fetchVectorTileTemplates({
      styleUrl: 'https://x/resources/styles/root.json',
    })
    expect(result).toEqual([
      'https://x/VectorTileServer/tile/{z}/{y}/{x}.pbf',
      'https://tiles.example/{z}/{x}/{y}.pbf',
    ])
  })
})

describe('toCesiumMvtTemplate', () => {
  it('把 ArcGIS y/x 顺序改成 Cesium x/y 顺序', () => {
    expect(toCesiumMvtTemplate('https://x/{z}/{y}/{x}.pbf')).toBe('https://x/{z}/{x}/{y}.pbf')
  })
})

describe('fetchVectorTileGeoJSON', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('HTTP 失败抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(fetchVectorTileGeoJSON('https://x/tile.pbf', 0, 0, 0)).rejects.toThrow('矢量瓦片加载失败')
  })

  it('拉取并解码一张瓦片为 FeatureCollection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }))
    )
    const out = await fetchVectorTileGeoJSON('https://x/tile/3/4/5.pbf', 3, 4, 5)
    expect(out.type).toBe('FeatureCollection')
    expect(out.features).toEqual([
      { type: 'Feature', properties: { name: 'road' }, geometry: { type: 'Point', coordinates: [116, 39] } },
    ])
  })
})

describe('applyVectorTileMemoryLimit', () => {
  it('给存在 tileset 的 provider 设置 cacheBytes 与 maximumCacheOverflowBytes', () => {
    const tileset = { cacheBytes: 0, maximumCacheOverflowBytes: 0 }
    const provider = { tileset }
    const ok = applyVectorTileMemoryLimit(provider as never, 64 * 1024 * 1024, 16 * 1024 * 1024)
    expect(ok).toBe(true)
    expect(tileset.cacheBytes).toBe(64 * 1024 * 1024)
    expect(tileset.maximumCacheOverflowBytes).toBe(16 * 1024 * 1024)
  })

  it('无 tileset 时返回 false 且不报错', () => {
    expect(applyVectorTileMemoryLimit({} as never, 1024)).toBe(false)
    expect(applyVectorTileMemoryLimit(null, 1024)).toBe(false)
    expect(applyVectorTileMemoryLimit({ tileset: null } as never, 1024)).toBe(false)
  })

  it('未传 overflowBytes 时不改动它', () => {
    const tileset = { cacheBytes: 0, maximumCacheOverflowBytes: 5 }
    applyVectorTileMemoryLimit({ tileset } as never, 2048)
    expect(tileset.cacheBytes).toBe(2048)
    expect(tileset.maximumCacheOverflowBytes).toBe(5)
  })
})
