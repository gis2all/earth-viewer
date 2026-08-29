import { describe, it, expect } from 'vitest'
import { processViewportData } from './viewportProcess'

describe('processViewportData', () => {
  it('正常数据解析并保留', () => {
    const r = processViewportData({ geojson: { features: [{ geometry: { coordinates: [0, 0] } }] }, maxVertices: 100, maxFeatures: 100 })
    expect(r.features.length).toBe(1)
    expect(r.capped).toBe(false)
    expect(r.vertices).toBe(1)
  })

  it('顶点超限时抽稀/截断并标记 capped', () => {
    const coords = Array.from({ length: 200 }, (_, i) => [i * 0.001, Math.sin(i)]) as [number, number][]
    const r = processViewportData({ geojson: { features: [{ geometry: { type: 'LineString', coordinates: coords } }] }, maxVertices: 10, maxFeatures: 100 })
    expect(r.capped).toBe(true)
    expect(r.vertices).toBeLessThanOrEqual(10)
  })

  it('坏数据容错', () => {
    expect(processViewportData({ geojson: null }).features.length).toBe(0)
    expect(processViewportData({ geojson: {} }).features.length).toBe(0)
  })
})

  it('要素超限时汇报 capped（便于调用方提示降级）', () => {
    const r = processViewportData({ geojson: { features: Array(2000) }, maxVertices: 100000, maxFeatures: 1500 })
    expect(r.capped).toBe(true)
    expect(r.features.length).toBe(1500)
  })
