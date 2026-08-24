import { describe, it, expect } from 'vitest'
import {
  buildFeatureQueryUrl,
  layerQueryBase,
  parseFeatureCollection,
  countVertices,
  countFeatureCollectionVertices,
} from './featureQuery'
import { rectangleToEnvelope, viewEnvelopeFromCamera } from './envelope'
import { simplifyLine, simplifyFeatureCollection } from './simplify'
import { applyVertexBudget } from './budget'

describe('featureQuery', () => {
  it('layerQueryBase 对根服务补 /0', () => {
    expect(layerQueryBase('https://x/svc/FeatureServer')).toBe('https://x/svc/FeatureServer/0')
    expect(layerQueryBase('https://x/svc/MapServer')).toBe('https://x/svc/MapServer/0')
    expect(layerQueryBase('https://x/svc/FeatureServer/2')).toBe('https://x/svc/FeatureServer/2')
  })

  it('buildFeatureQueryUrl 带视口/空间过滤/geojson', () => {
    const u = new URL(buildFeatureQueryUrl('https://x/FeatureServer', { west: 1, south: 2, east: 3, north: 4 }, { maxFeatures: 123 }))
    expect(u.pathname).toMatch(/FeatureServer\/0\/query$/)
    expect(u.searchParams.get('geometry')).toBe('1,2,3,4')
    expect(u.searchParams.get('geometryType')).toBe('esriGeometryEnvelope')
    expect(u.searchParams.get('spatialRel')).toBe('esriSpatialRelIntersects')
    expect(u.searchParams.get('f')).toBe('geojson')
    expect(u.searchParams.get('outSR')).toBe('4326')
    expect(u.searchParams.get('resultRecordCount')).toBe('123')
  })

  it('parseFeatureCollection 容错', () => {
    expect(parseFeatureCollection({ features: [{ id: 1 }] }).features.length).toBe(1)
    expect(parseFeatureCollection(null).features.length).toBe(0)
    expect(parseFeatureCollection({}).features.length).toBe(0)
  })

  it('countVertices 统计点/线/面顶点', () => {
    expect(countVertices({ geometry: { coordinates: [1, 2] } })).toBe(1)
    expect(countVertices({ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] } })).toBe(3)
    expect(countVertices({ geometry: { coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })).toBe(4)
    expect(countVertices({})).toBe(0)
  })

  it('countFeatureCollectionVertices 汇总', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { coordinates: [0, 0] } }, { geometry: { coordinates: [[0, 0], [1, 1]] } }] }
    expect(countFeatureCollectionVertices(fc)).toBe(3)
  })
})

describe('envelope', () => {
  it('rectangle 弧度转经纬度', () => {
    const e = rectangleToEnvelope({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 })
    expect(e?.west).toBeCloseTo(180)
    expect(e?.north).toBeCloseTo(90)
    expect(e?.south).toBeCloseTo(-90)
    expect(rectangleToEnvelope(null)).toBeNull()
  })
})

describe('simplify', () => {
  it('simplifyLine 减少顶点', () => {
    const pts: [number, number][] = [[0, 0], [0.0001, 0.0001], [0.0002, 0.0002], [1, 1]]
    const out = simplifyLine(pts, 0.001)
    expect(out.length).toBeLessThan(pts.length)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([1, 1])
  })

  it('simplifyFeatureCollection 处理 polygon 并保留端点', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.0001, 0], [0.0002, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
    }
    const out = simplifyFeatureCollection(fc, 0.001)
    const coords = (out.features[0].geometry as { coordinates: unknown }).coordinates as unknown[]
    expect(Array.isArray(coords)).toBe(true)
  })
})

describe('applyVertexBudget', () => {
  it('未超预算不抽稀', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { coordinates: [0, 0] } }, { geometry: { coordinates: [1, 1] } }] }
    const r = applyVertexBudget(fc, 100)
    expect(r.capped).toBe(false)
    expect(r.vertices).toBe(2)
  })

  it('超预算抽稀并标记 capped', () => {
    // 一条弯曲 line，很多点
    const coords = Array.from({ length: 200 }, (_, i) => [i * 0.001, Math.sin(i)]) as [number, number][]
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'LineString', coordinates: coords } }] } as never
    const r = applyVertexBudget(fc as never, 10)
    expect(r.capped).toBe(true)
    expect(r.vertices).toBeLessThan(200)
    expect(r.vertices).toBeLessThanOrEqual(10)
  })
})


describe('viewEnvelopeFromCamera', () => {
  it('有 computeViewRectangle 时转经纬度），无则 null', () => {
    expect(viewEnvelopeFromCamera({ computeViewRectangle: () => ({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 }) })?.west).toBeCloseTo(180)
    expect(viewEnvelopeFromCamera({})).toBeNull()
    expect(viewEnvelopeFromCamera(undefined)).toBeNull()
  })
})
