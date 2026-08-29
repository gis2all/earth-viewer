import { describe, it, expect } from 'vitest'
import { clusterPoints } from './cluster'

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
