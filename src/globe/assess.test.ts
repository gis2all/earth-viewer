import { describe, it, expect } from 'vitest'
import { assessWebmap, classifyLayer, renderableLayersFromWebmap, skippedBusinessLayers } from './assess'
import type { WebLayer } from './webmap'

const layer = (l: Partial<WebLayer>): WebLayer => ({ title: 't', ...l })

describe('classifyLayer 能力表', () => {
  it('MapServer 瓦片完整支持', () => {
    const l = layer({ url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })
    expect(classifyLayer(l, 'basemap').support).toBe('full')
  })
  it('动态 MapServer / MapService 也视为 full（由 export 渲染）', () => {
    expect(classifyLayer(layer({ url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' }), 'basemap').support).toBe('full')
  })
  it('ImageServer / TiledImage 完整支持', () => {
    expect(classifyLayer(layer({ url: 'https://x/ImageServer', layerType: 'ArcGISImageServiceLayer' }), 'basemap').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/ImageServer', layerType: 'ArcGISTiledImageServiceLayer' }), 'business').support).toBe('full')
  })
  it('VectorTile 无 url 默认不支持；有 url 或有 styleUrl → full（MapLibre 官方样式）', () => {
    const none = classifyLayer(layer({ url: '', layerType: 'VectorTileLayer' }), 'basemap')
    expect(none.support).toBe('none')
    expect(none.reason).toBeTruthy()
    expect(classifyLayer(layer({ url: 'https://x/VectorTileServer', layerType: 'VectorTileLayer', styleUrl: 'https://x/style' }), 'basemap').support).toBe('full')
  })
  it('3D Scene / I3S → partial（客户端 I3S 渲染）', () => {
    const a = classifyLayer(layer({ url: 'https://x/SceneServer/0', layerType: 'ArcGISSceneServiceLayer' }), 'business')
    expect(a.support).toBe('partial')
    expect(a.reason).toBeTruthy()
  })
  it('3D Tiles → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/tileset.json', layerType: '3DTilesService' }), 'business').support).toBe('partial')
  })
  it('IntegratedMesh / PointCloud / 3DObject 场景子层 → partial（I3S）', () => {
    expect(classifyLayer(layer({ url: 'https://x/SceneServer/layers/0', layerType: 'IntegratedMeshLayer' }), 'business').support).toBe('partial')
    expect(classifyLayer(layer({ url: 'https://x/SceneServer/layers/0', layerType: 'PointCloudLayer' }), 'business').support).toBe('partial')
    expect(classifyLayer(layer({ url: 'https://x/SceneServer/layers/0', layerType: 'ArcGIS3DObjectLayer' }), 'business').support).toBe('partial')
  })
  it('WMS 带图层名 → full；缺图层名 → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/wms', layerType: 'WMSLayer', layers: [{ name: 'a' }] }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/wms', type: 'WMS', layers: [{ name: 'a' }] }), 'business').support).toBe('full')
    const noName = classifyLayer(layer({ url: 'https://x/wms', type: 'WMS' }), 'business')
    expect(noName.support).toBe('partial')
    expect(noName.reason).toBeTruthy()
  })
  it('WMTS 带配置 → full；缺配置 → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/WMTS', layerType: 'WMTSLayer', layers: [{ name: 'a' }] }), 'business').support).toBe('full')
    const noCfg = classifyLayer(layer({ url: 'https://x/WMTS', layerType: 'WMTSLayer' }), 'business')
    expect(noCfg.support).toBe('partial')
  })
  it('WFS / OGCFeatureServer → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/FeatureServer', layerType: 'OGCFeatureServer' }), 'business').support).toBe('partial')
    expect(classifyLayer(layer({ url: 'https://x/wfs', type: 'WFS' }), 'business').support).toBe('partial')
  })
  it('GeoJSONLayer / CSV → partial', () => {
    expect(classifyLayer(layer({ url: 'https://x/a.geojson', layerType: 'GeoJSONLayer' }), 'business').support).toBe('partial')
    expect(classifyLayer(layer({ url: 'https://x/a.csv', layerType: 'CSVLayer' }), 'business').support).toBe('partial')
  })
  it('WebTiledLayer / OpenStreetMap → full', () => {
    expect(classifyLayer(layer({ url: 'https://x/{z}/{y}/{x}', layerType: 'WebTiledLayer' }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x', type: 'OpenStreetMap' }), 'business').support).toBe('full')
  })
  it('KML 支持（含真实 type "KML"）', () => {
    expect(classifyLayer(layer({ url: 'https://x/a.kml', layerType: 'KMLLayer' }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/a.kml', type: 'KML' }), 'business').support).toBe('full')
    expect(classifyLayer(layer({ url: 'https://x/a.kmz', type: 'KML Collection' }), 'business').support).toBe('full')
  })
  it('无 url 不支持', () => {
    expect(classifyLayer(layer({ url: '', layerType: 'ArcGISTiledMapServiceLayer' }), 'basemap').support).toBe('none')
  })
  it('流/交通辅助/流服务 → none', () => {
    expect(classifyLayer(layer({ url: 'https://x', layerType: 'ArcGISStreamLayer' }), 'business').support).toBe('none')
    expect(classifyLayer(layer({ url: 'https://x', layerType: 'GeoRSSLayer' }), 'business').support).toBe('none')
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
  it('纯 VectorTile 底图（无 url）→ 不可渲染', () => {
    const wm = {
      baseMap: { baseMapLayers: [layer({ title: 'Streets', url: '', layerType: 'VectorTileLayer' })] },
      operationalLayers: [],
    }
    expect(assessWebmap(wm as unknown as Record<string, unknown>).renderable).toBe(false)
  })
  it('纯 VectorTile 底图（带 styleUrl）→ 可渲染 full（MapLibre 官方样式）', () => {
    const wm = {
      baseMap: { baseMapLayers: [layer({ title: 'Streets', url: 'https://x/VectorTileServer', layerType: 'VectorTileLayer', styleUrl: 'https://x/style' })] },
      operationalLayers: [],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.renderable).toBe(true)
    expect(a.fidelity).toBe('full')
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
  })
  it('MapServer 底图 → full（非 partial）', () => {
    const wm = {
      baseMap: { baseMapLayers: [layer({ title: 'World Imagery', url: 'https://x/World_Imagery/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })] },
      operationalLayers: [],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.fidelity).toBe('full')
  })
  it('分组图层展平后参与评估', () => {
    const wm = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [
        layer({
          title: 'Group', layerType: 'ArcGISGroupLayer',
          layers: [
            layer({ title: 'Sub Full', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
            layer({ title: 'Sub None', url: '', layerType: 'VectorTileLayer' }),
          ],
        }),
      ],
    }
    const a = assessWebmap(wm as unknown as Record<string, unknown>)
    expect(a.layers.length).toBe(2)
    expect(a.renderable).toBe(true)
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

  it('分组图层展平后渲染其子层', () => {
    const wm = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [
        layer({
          title: 'Group', layerType: 'ArcGISGroupLayer',
          layers: [
            layer({ title: 'F1', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
            layer({ title: 'F2', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }),
          ],
        }),
      ],
    }
    const layers = renderableLayersFromWebmap(wm as unknown as Record<string, unknown>)
    expect(layers.map((l) => l.title)).toEqual(['F1', 'F2'])
  })

  it('超过 MAX_BUSINESS_LAYERS 的业务层被裁剪（保留前 5 个，overlay 仍过滤）', () => {
    const ops = Array.from({ length: 8 }, (_, i) => layer({ title: 'B' + i, url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    const wm = {
      baseMap: {
        baseMapLayers: [layer({ title: 'Hillshade', url: 'https://x/Elevation/World_Hillshade/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })],
      },
      operationalLayers: ops,
    }
    const layers = renderableLayersFromWebmap(wm as unknown as Record<string, unknown>)
    expect(layers.length).toBe(5)
    expect(layers.map((l) => l.title)).toEqual(['B0', 'B1', 'B2', 'B3', 'B4'])
  })

  it('skippedBusinessLayers 返回被省略的业务层数（0 或正数）', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => layer({ title: 'B' + i, url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    expect(skippedBusinessLayers({ baseMap: { baseMapLayers: [] }, operationalLayers: mk(8) } as unknown as Record<string, unknown>)).toBe(3)
    expect(skippedBusinessLayers({ baseMap: { baseMapLayers: [] }, operationalLayers: mk(2) } as unknown as Record<string, unknown>)).toBe(0)
    expect(skippedBusinessLayers({ baseMap: { baseMapLayers: [] }, operationalLayers: [] } as unknown as Record<string, unknown>)).toBe(0)
  })
})
