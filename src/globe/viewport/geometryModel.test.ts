import { describe, it, expect } from 'vitest'
import { featuresToGeometryModel } from './geometryModel'

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
