import { describe, it, expect, vi } from 'vitest'
import { runViewportProcess } from './viewportWorker'

describe('runViewportProcess', () => {
  it('无 Worker 环境回退同步处理', async () => {
    const r = await runViewportProcess({ geojson: { features: [{ geometry: { coordinates: [0, 0] } }] }, maxVertices: 100, maxFeatures: 100 })
    expect(r.features.length).toBe(1)
    expect(r.vertices).toBe(1)
    expect(r.capped).toBe(false)
  })

  it('坏数据容错', async () => {
    const r = await runViewportProcess({ geojson: null })
    expect(r.features.length).toBe(0)
  })
})


  it('Worker 可用时走 worker 分支', async () => {
    vi.stubGlobal('Worker', class {
      onmessage: ((e: { data: { id: string; result: unknown } }) => void) | null = null
      onerror: unknown = null
      postMessage(data: { id: string; input: unknown }) {
        this.onmessage?.({ data: { id: data.id, result: { features: [], capped: false, vertices: 0 } } })
      }
      terminate() {}
    } as unknown)
    const r = await runViewportProcess({ geojson: { features: [] } })
    expect(r.features.length).toBe(0)
    vi.unstubAllGlobals()
  })

describe('runViewportProcess 回退分支', () => {
  it('Worker 下发生 onerror 时回退同步处理', async () => {
    vi.stubGlobal('Worker', class {
      onmessage: unknown = null
      onerror: (() => void) | null = null
      postMessage() { this.onerror?.() }
      terminate() {}
    } as unknown)
    const r = await runViewportProcess({ geojson: { features: [{ geometry: { coordinates: [0, 0] } }] }, maxVertices: 100, maxFeatures: 100 })
    expect(r.features.length).toBe(1)
    vi.unstubAllGlobals()
  })

  it('new Worker 抛错时回退同步处理', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no worker') } } as unknown)
    const r = await runViewportProcess({ geojson: { features: [] } })
    expect(r.features.length).toBe(0)
    vi.unstubAllGlobals()
  })
})
