import { describe, it, expect } from 'vitest'
import { rectangleToEnvelope, viewEnvelopeFromCamera, clusterPoints, featuresToGeometryModel, simplifyLine, simplifyFeatureCollection } from './geometry'

describe('envelope', () => {
  it('rectangle 弧度转经纬度', () => {
    const e = rectangleToEnvelope({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 })
    expect(e?.west).toBeCloseTo(180)
    expect(e?.north).toBeCloseTo(90)
    expect(e?.south).toBeCloseTo(-90)
    expect(rectangleToEnvelope(null)).toBeNull()
  })
})

describe('viewEnvelopeFromCamera', () => {
  it('有 computeViewRectangle 时转经纬度，无则 null', () => {
    expect(viewEnvelopeFromCamera({ computeViewRectangle: () => ({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 }) })?.west).toBeCloseTo(180)
    expect(viewEnvelopeFromCamera({})).toBeNull()
    expect(viewEnvelopeFromCamera(undefined)).toBeNull()
  })
})

describe('clusterPoints', () => {
  it('把同网格点聚合并计数', () => {
    const pts = [[1, 1], [1.01, 1.01], [1.02, 1.02], [10, 10]]
    const c = clusterPoints(pts, 0.1)
    expect(c.length).toBe(2)
    expect(c[0].count).toBe(3)
    expect(c[0].lon).toBeGreaterThan(1)
    expect(c[0].lon).toBeLessThan(1.03)
    expect(c[1].count).toBe(1)
  })

  it('坏数据容错', () => {
    expect(clusterPoints([], 0.1).length).toBe(0)
    expect(clusterPoints([[null, null]] as never, 0.1).length).toBe(0)
    expect(clusterPoints([[1, 1]], 0).length).toBe(0)
  })
})

describe('featuresToGeometryModel', () => {
  it('分点/线/面', () => {
    const feats = [
      { geometry: { type: 'Point', coordinates: [1, 2] } },
      { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] } },
    ] as never
    const m = featuresToGeometryModel(feats)
    expect(m.points.length).toBe(1)
    expect(m.lines.length).toBe(1)
    expect(m.polygons.length).toBe(1)
  })

  it('容错：空/坏数据', () => {
    expect(featuresToGeometryModel([]).points.length).toBe(0)
    expect(featuresToGeometryModel([{ geometry: { type: 'Point', coordinates: null } }] as never).points.length).toBe(0)
    expect(featuresToGeometryModel([{}] as never).points.length).toBe(0)
  })

  it('处理 MultiPoint / MultiLineString / MultiPolygon', () => {
    const feats = [
      { geometry: { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] } },
      { geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] } },
      { geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 1], [0, 0]]], [[[2, 2], [3, 2], [2, 3], [2, 2]]]] } },
    ] as never
    const m = featuresToGeometryModel(feats)
    expect(m.points).toEqual([[1, 2], [3, 4]])
    expect(m.lines).toHaveLength(2)
    expect(m.polygons).toHaveLength(2)
  })

  it('容错：坐标非数组或类型未知的几何不分配', () => {
    const m = featuresToGeometryModel([
      { geometry: { type: 'Point', coordinates: 'x,y' } },
      { geometry: { type: 'UnknownType', coordinates: [1, 2] } },
      { geometry: { type: 'Point' } },
    ] as never)
    expect(m.points.length).toBe(0)
    expect(m.lines.length).toBe(0)
    expect(m.polygons.length).toBe(0)
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
