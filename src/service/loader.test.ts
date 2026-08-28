import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyLayerBudget,
  loadLayerData,
  type LoaderOptions,
} from './loader'

vi.mock('./repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repository')>()
  return {
    ...actual,
    fetchWebmap: vi.fn(async (id: string) => ({ id, title: 'mock webmap' })),
    fetchFeatureGeoJSON: vi.fn(async () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] })),
    preflightItem: vi.fn(async () => true),
    fetchItemMetadata: vi.fn(async () => null),
  }
})

vi.mock('../globe/loadSafety', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../globe/loadSafety')>()
  return {
    ...mod,
    assertUrlWithinLimit: vi.fn(async () => undefined),
    consumeFeatureBudget: mod.consumeFeatureBudget,
  }
})

vi.mock('../globe/viewport/worker', () => ({
  runViewportProcess: vi.fn(async (input: { geojson: unknown; maxVertices?: number; maxFeatures?: number }) => {
    const raw = input.geojson as { features?: unknown[] }
    return { features: raw.features ?? [], capped: false, vertices: 0 }
  }),
}))

vi.mock('../globe/kml', () => ({
  parseKmlToGeoJSON: vi.fn((text: string) => ({
    type: 'FeatureCollection',
    features: text.includes('<Placemark>') ? [{ type: 'Feature', properties: {}, geometry: null }] : [],
  })),
}))

vi.mock('../globe/csv', () => ({
  fetchCsvGeoJSON: vi.fn(async () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] })),
}))

vi.mock('../globe/ogc', () => ({
  fetchOgcFeatureGeoJSON: vi.fn(async () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }] })),
}))

const fetchStub = vi.fn()
vi.stubGlobal('fetch', fetchStub)

import { fetchWebmap, fetchFeatureGeoJSON, preflightItem } from './repository'
import { runViewportProcess } from '../globe/viewport/worker'
import { parseKmlToGeoJSON } from '../globe/kml'
import { fetchCsvGeoJSON } from '../globe/csv'
import { fetchOgcFeatureGeoJSON } from '../globe/ogc'

const abortSignal = (): AbortSignal => new AbortController().signal

describe('loadLayerData 管线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('容器带内嵌 webmap → 直接返回，不预检、不请求', async () => {
    const r = await loadLayerData({ id: 'wm1', type: 'Web Map', webmap: { baseMap: {} } }, abortSignal())
    expect(r).toMatchObject({ kind: 'webmap', data: { baseMap: {} }, preflight: true })
    expect(preflightItem).not.toHaveBeenCalled()
    expect(fetchWebmap).not.toHaveBeenCalled()
  })

  it('容器无内嵌 → repository.fetchWebmap 取数', async () => {
    const r = await loadLayerData({ id: 'wm2', type: 'Web Map' }, abortSignal())
    expect(r).toMatchObject({ kind: 'webmap', data: { id: 'wm2' } })
    expect(fetchWebmap).toHaveBeenCalledWith('wm2', expect.anything())
  })

  it('预检失败 → 抛 network LayerLoadError', async () => {
    vi.mocked(preflightItem).mockResolvedValueOnce(false)
    await expect(loadLayerData({ id: 'x1', layerType: 'ArcGISFeatureLayer', url: 'https://x/FeatureServer' }, abortSignal())).rejects.toMatchObject({ code: 'network' })
  })

  it('feature：预检 → fetchFeatureGeoJSON → viewport → 预算消费', async () => {
    const r = await loadLayerData({ id: 'f1', layerType: 'ArcGISFeatureLayer', url: 'https://f/FeatureServer' }, abortSignal(), { policy: { maxTotalFeatures: 10, maxFeatures: 3000, maxRenderFeatures: 5, maxRenderVertices: 1000 } as LoaderOptions['policy'] })
    expect(preflightItem).toHaveBeenCalled()
    expect(fetchFeatureGeoJSON).toHaveBeenCalled()
    expect(runViewportProcess).toHaveBeenCalled()
    expect(r).toMatchObject({ kind: 'feature', capped: false })
  })

  it('预算耗尽 → 抛 budget LayerLoadError（跳过该层）', async () => {
    const policy = {
      maxTotalFeatures: 0,
      maxFeatures: 3000,
      maxRenderFeatures: 5,
      maxRenderVertices: 1000,
      maxFileBytes: 8_000_000,
      kmlMaxBytes: 2_000_000,
      vectorTileMaxZoom: 16,
      imageryMaxLevel: 16,
    }
    await expect(loadLayerData({ id: 'f2', layerType: 'ArcGISFeatureLayer', url: 'https://f/FeatureServer' }, abortSignal(), { policy })).rejects.toMatchObject({ code: 'budget' })
  })

  it('kml：文本 → parseKmlToGeoJSON → viewport；无要素不抛错', async () => {
    fetchStub.mockResolvedValueOnce({ ok: true, text: async () => '<kml><Placemark/></kml>' } as unknown as Response)
    const r = await loadLayerData({ id: 'k1', layerType: 'KMLLayer', url: 'https://k/file.kml' }, abortSignal())
    expect(parseKmlToGeoJSON).toHaveBeenCalledWith('<kml><Placemark/></kml>')
    expect(r).toMatchObject({ kind: 'kml' })
  })

  it('csv / wfs：协议适配器取数后走统一预算', async () => {
    const csv = await loadLayerData({ id: 'c1', layerType: 'CSVLayer', url: 'https://c/a.csv' }, abortSignal())
    expect(fetchCsvGeoJSON).toHaveBeenCalled()
    expect(csv).toMatchObject({ kind: 'csv' })
    const wfs = await loadLayerData({ id: 'w1', layerType: 'WFS', url: 'https://w/ows' }, abortSignal())
    expect(fetchOgcFeatureGeoJSON).toHaveBeenCalled()
    expect(wfs).toMatchObject({ kind: 'wfs' })
  })

  it('geojson：直接 fetch 并解析；HTTP 失败 → network', async () => {
    fetchStub.mockResolvedValueOnce({ ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) } as unknown as Response)
    const gj = await loadLayerData({ id: 'g1', layerType: 'GeoJSONLayer', url: 'https://g/data.geojson' }, abortSignal())
    expect(gj).toMatchObject({ kind: 'geojson' })
    fetchStub.mockResolvedValueOnce({ ok: false } as unknown as Response)
    await expect(loadLayerData({ id: 'g2', layerType: 'GeoJSONLayer', url: 'https://g/bad.geojson' }, abortSignal())).rejects.toMatchObject({ code: 'network' })
  })

  it('影像类（map/image/wms/wmts/vector/scene）→ 返回源描述，不取要素', async () => {
    const cases: Array<[string, string]> = [
      ['ArcGISMapServiceLayer', 'map'],
      ['ArcGISImageServiceLayer', 'image'],
      ['WMSLayer', 'wms'],
      ['WMTSLayer', 'wmts'],
      ['VectorTileLayer', 'vector'],
      ['ArcGISSceneServiceLayer', 'scene'],
    ]
    for (const [layerType, kind] of cases) {
      const r = await loadLayerData({ id: layerType, layerType, url: `https://x/${layerType}` }, abortSignal())
      expect(r).toMatchObject({ kind, data: { url: `https://x/${layerType}` } })
      expect(fetchFeatureGeoJSON).not.toHaveBeenCalled()
    }
  })

  it('未知类型 → unsupported', async () => {
    await expect(loadLayerData({ id: 'u1', layerType: 'Weird', url: 'https://x' }, abortSignal())).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('applyLayerBudget', () => {
  it('空要素不消耗预算', () => {
    const budget = { remaining: 0 }
    const r = applyLayerBudget(budget, { type: 'FeatureCollection', features: [] })
    expect(r).toMatchObject({ capped: false, remaining: 0 })
  })

  it('超单层上限 → 截断并标记 capped', () => {
    const budget = { remaining: 100 }
    const feats = Array.from({ length: 20 }, (_, i) => ({ type: 'Feature', properties: { i }, geometry: null }))
    const r = applyLayerBudget(budget, { type: 'FeatureCollection', features: feats }, {
      maxRenderFeatures: 5,
      maxRenderVertices: 1000,
      maxTotalFeatures: 100,
      maxFeatures: 3000,
      maxFileBytes: 8_000_000,
      kmlMaxBytes: 2_000_000,
      vectorTileMaxZoom: 16,
      imageryMaxLevel: 16,
    })
    expect(r?.capped).toBe(true)
    expect((r?.data as { features: unknown[] }).features.length).toBe(5)
    expect(budget.remaining).toBe(95)
  })
})
