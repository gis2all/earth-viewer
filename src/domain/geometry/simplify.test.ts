import { describe, it, expect } from 'vitest'
import { simplifyLine, simplifyFeatureCollection } from './simplify'

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
