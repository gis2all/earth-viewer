import { describe, it, expect, vi } from 'vitest'
import { isGlobalVectorTileLayer, riskOfLayer, degradeReason, SAFETY, assertUrlWithinLimit } from './loadSafety'

function layer(over: Record<string, unknown>) {
  return over as never
}

describe('loadSafety', () => {
  it('detects global vector basemaps (OSM / ArcGIS basemaps)', () => {
    expect(isGlobalVectorTileLayer(layer({ layerType: 'VectorTileLayer', title: 'OpenStreetMap Style', styleUrl: 'https://cdn.arcgis.com/.../styles/root.json' }))).toBe(true)
    expect(isGlobalVectorTileLayer(layer({ layerType: 'VectorTileLayer', url: 'https://basemaps.arcgis.com/arcgis/rest/services/OpenBasemap_v2/VectorTileServer' }))).toBe(true)
    expect(isGlobalVectorTileLayer(layer({ layerType: 'VectorTileLayer', title: 'World Street Map', styleUrl: 'https://cdn.arcgis.com/sharing/rest/content/items/de26a3cf4cc9451298ea173c4b324736/resources/styles/root.json' }))).toBe(true)
  })

  it('does not treat local vector tiles as global basemap', () => {
    expect(isGlobalVectorTileLayer(layer({ layerType: 'VectorTileLayer', url: 'https://example.com/tiles/streets' }))).toBe(false)
  })

  it('classifies risk levels', () => {
    expect(riskOfLayer(layer({ layerType: 'VectorTileLayer', title: 'OpenStreetMap Style' }))).toBe('heavy')
    expect(riskOfLayer(layer({ layerType: 'ArcGISFeatureLayer', url: 'https://x/FeatureServer' }))).toBe('heavy')
    expect(riskOfLayer(layer({ layerType: 'WMSLayer', url: 'https://x/wms' }))).toBe('medium')
    expect(riskOfLayer(layer({ layerType: 'GeoJSONLayer', url: 'https://x/a.geojson' }))).toBe('medium')
    expect(riskOfLayer(layer({ layerType: 'ArcGISTiledMapServiceLayer', url: 'https://x/MapServer' }))).toBe('medium')
  })

  it('provides degrade reason for heavy layers only', () => {
    expect(degradeReason(layer({ layerType: 'VectorTileLayer', title: 'OpenStreetMap Style' }))).toBeTruthy()
    expect(degradeReason(layer({ layerType: 'ArcGISFeatureLayer', url: 'https://x/FeatureServer' }))).toBeTruthy()
    expect(degradeReason(layer({ layerType: 'GeoJSONLayer', url: 'https://x/a.geojson' }))).toBeUndefined()
  })

  it('classifies heavy 3D and light layers, and non-vectortile kinds', () => {
    expect(riskOfLayer(layer({ layerType: 'SceneLayer', url: 'https://x/SceneServer' }))).toBe('heavy')
    expect(riskOfLayer(layer({ layerType: 'Cesium3DTiles', url: 'https://x/tileset.json' }))).toBe('heavy')
    expect(riskOfLayer(layer({ layerType: 'WebTiledLayer', urlTemplate: 'https://x/{z}/{y}/{x}' }))).toBe('light')
    expect(riskOfLayer(layer({ layerType: 'UnknownThing' }))).toBe('light')
    expect(isGlobalVectorTileLayer(layer({ layerType: 'ArcGISTiledMapServiceLayer', url: 'https://x/MapServer' }))).toBe(false)
  })

  it('assertUrlWithinLimit enforces size cap (HEAD)', async () => {
    vi.stubGlobal('navigator', { userAgent: 'chrome' })
    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Map([['content-length', '99999999']]) })))
      await expect(assertUrlWithinLimit('https://x/big.geojson', 1000)).rejects.toThrow()
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Map([['content-length', '100']]) })))
      await expect(assertUrlWithinLimit('https://x/small.geojson', 1000)).resolves.toBeUndefined()
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
      await expect(assertUrlWithinLimit('https://x/missing.geojson', 1000)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes sane safety limits', () => {
    expect(SAFETY.MAX_FEATURES).toBeGreaterThan(0)
    expect(SAFETY.VECTOR_TILE_MAX_ZOOM).toBeLessThan(14)
  })
})
