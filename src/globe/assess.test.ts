import { describe, it, expect } from 'vitest'
import { assessWebmap, classifyLayer, renderableLayersFromWebmap } from './assess'
import type { WebLayer } from './webmap'

const layer = (l: Partial<WebLayer>): WebLayer => ({ title: 't', ...l })

describe('classifyLayer 能力表', () => {
  it('MapServer 瓦片完整支持', () => {
    const l = layer({ url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })
    expect(classifyLayer(l, 'basemap').support).toBe('full')
  })
  it('VectorTile 不支持并带原因', () => {
    const l = layer({ url: '', layerType: 'VectorTileLayer' })
    const a = classifyLayer(l, 'basemap')
    expect(a.support).toBe('none')
    expect(a.reason).toBeTruthy()
  })
  it('3D Scene 不支持', () => {
    const l = layer({ url: 'https://x/SceneServer/0', layerType: 'ArcGISSceneServiceLayer' })
    expect(classifyLayer(l, 'business').support).toBe('none')
  })
  it('WMS 带图层名 → full；缺图层名 → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/wms', layerType: 'WMSLayer', layers: [{ name: 'a' }] }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/wms', type: 'WMS', layers: [{ name: 'a' }] }), 'business').support).toBe('full')
    const noName = classifyLayer(layer({ url: 'https://x/wms', type: 'WMS' }), 'business')
    expect(noName.support).toBe('partial')
    expect(noName.reason).toBeTruthy()
  })
  it('KML 支持（含真实 type "KML"）', () => {
    expect(classifyLayer(layer({ url: 'https://x/a.kml', layerType: 'KMLLayer' }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/a.kml', type: 'KML' }), 'business').support).toBe('full')
  })
  it('无 url 不支持', () => {
    expect(classifyLayer(layer({ url: '', layerType: 'ArcGISTiledMapServiceLayer' }), 'basemap').support).toBe('none')
  })
})

describe('assessWebmap 整体评估', () => {
  it('Imagery Hybrid（MapServer 底图 + VectorTile 标注）→ renderable, partial', () => {
    const wm = {
      baseMap: {
        baseMapLayers: [
          layer({ title: 'World Imagery', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
          layer({ title: 'Hybrid Reference', url: '', layerType: 'VectorTileLayer' }),
        ],
      },
      operationalLayers: [],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.renderable).toBe(true)
    expect(a.fidelity).toBe('partial')
  })
  it('纯 VectorTile 底图 → 不可渲染', () => {
    const wm = {
      baseMap: { baseMapLayers: [layer({ title: 'Streets', url: '', layerType: 'VectorTileLayer' })] },
      operationalLayers: [],
    }
    expect(assessWebmap(wm as unknown as Record<string, unknown>).renderable).toBe(false)
  })
  it('只有 Hillshade 辅助层 → 不可渲染', () => {
    const wm = {
      baseMap: {
        baseMapLayers: [
          layer({ title: 'World Hillshade', url: 'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
          layer({ title: 'Charted Territory', url: '', layerType: 'VectorTileLayer' }),
        ],
      },
      operationalLayers: [],
    }
    expect(assessWebmap(wm as unknown as Record<string, unknown>).renderable).toBe(false)
  })
  it('业务 FeatureLayer → 可渲染但降级为 partial', () => {
    const wm = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [layer({ title: 'Incidents', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' })],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.renderable).toBe(true)
    expect(a.fidelity).toBe('partial')
    expect(a.layers[0].support).toBe('partial')
    expect(a.layers[0].reason).toBeTruthy()
  })
  it('MapServer 底图 → full（非 partial）', () => {
    const wm = {
      baseMap: { baseMapLayers: [layer({ title: 'World Imagery', url: 'https://x/World_Imagery/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })] },
      operationalLayers: [],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.fidelity).toBe('full')
    expect(a.layers[0].support).toBe('full')
  })
})

describe('renderableLayersFromWebmap', () => {
  it('partial 要素图层也会被渲染（降级但可用）', () => {
    const wm = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [layer({ title: 'Incidents', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' })],
    }
    const layers = renderableLayersFromWebmap(wm as unknown as Record<string, unknown>)
    expect(layers.length).toBe(1)
    expect(layers[0].title).toBe('Incidents')
  })

  it('跳过 overlay 与 none 层，保留主底图', () => {
    const wm = {
      baseMap: {
        baseMapLayers: [
          layer({ title: 'Hillshade', url: 'https://x/Elevation/World_Hillshade/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
          layer({ title: 'Topo', url: 'https://x/World_Topo_Map/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
          layer({ title: 'Vector', url: '', layerType: 'VectorTileLayer' }),
        ],
      },
      operationalLayers: [],
    }
    const layers = renderableLayersFromWebmap(wm as unknown as Record<string, unknown>)
    expect(layers.length).toBe(1)
    expect(layers[0].title).toBe('Topo')
  })
})
