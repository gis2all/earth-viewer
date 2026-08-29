import { describe, it, expect } from 'vitest'
import {
  buildFeatureQueryUrl,
  layerQueryBase,
  parseFeatureCollection,
  countVertices,
  countFeatureCollectionVertices,
} from './featureQuery'

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
