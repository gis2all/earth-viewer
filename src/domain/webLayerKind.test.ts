import { describe, it, expect } from 'vitest'
import {
  isCsvInput,
  isFeatureCollectionInput,
  isFeatureInput,
  isGeoJsonInput,
  isImageInput,
  isKmlInput,
  isMapInput,
  isSceneInput,
  is3dTilesInput,
  isVectorTileInput,
  isWfsInput,
  isWmsInput,
  isWmtsInput,
  layerKindOf,
} from './webLayerKind'

// —— 迁移自 webmap.test.ts 的「图层类型判断」用例（判定逻辑已收敛到 domain）——

describe('kind 判定（迁移自 webmap.test.ts）', () => {
  it('isFeatureInput', () => {
    expect(isFeatureInput({ layerType: 'ArcGISFeatureLayer', url: 'x' })).toBe(true)
    expect(isFeatureInput({ layerType: 'GeoJSONLayer', url: 'x' })).toBe(false)
  })

  it('isGeoJsonInput / isKmlInput', () => {
    expect(isGeoJsonInput({ layerType: 'GeoJSONLayer' })).toBe(true)
    expect(isKmlInput({ layerType: 'KMLLayer' })).toBe(true)
    expect(isKmlInput({ type: 'KML Collection' })).toBe(true)
  })

  it('isFeatureCollectionInput（内嵌要素集）', () => {
    expect(isFeatureCollectionInput({ type: 'Feature Collection' })).toBe(true)
    expect(
      isFeatureCollectionInput({ layerType: 'FeatureCollection', layerDefinition: { featureCollection: {} } })
    ).toBe(true)
    expect(isFeatureCollectionInput({ layerType: 'GeoJSONLayer' })).toBe(false)
    expect(isFeatureCollectionInput({ layerType: 'FeatureLayer' })).toBe(false)
  })
})

describe('kind 判定（其余类型）', () => {
  it('服务类', () => {
    expect(isMapInput({ url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })).toBe(true)
    expect(isMapInput({ layerType: 'ArcGISMapServiceLayer', url: 'https://x' })).toBe(true)
    expect(isImageInput({ url: 'https://x/ImageServer' })).toBe(true)
    expect(isWmsInput({ type: 'WMSLayer' })).toBe(true)
    expect(isWmsInput({ type: 'WMS' })).toBe(true)
    expect(isWmtsInput({ layerType: 'WMTSLayer' })).toBe(true)
  })

  it('矢量瓦片 / 场景 / 3D Tiles / WFS / CSV', () => {
    expect(isVectorTileInput({ layerType: 'VectorTileLayer' })).toBe(true)
    expect(isSceneInput({ layerType: 'ArcGISSceneServiceLayer' })).toBe(true)
    expect(isSceneInput({ layerType: 'SceneLayer' })).toBe(true)
    expect(is3dTilesInput({ layerType: 'Cesium3DTiles' })).toBe(true)
    expect(is3dTilesInput({ url: 'https://x/tileset.json' })).toBe(true)
    expect(isWfsInput({ layerType: 'WFS' })).toBe(true)
    expect(isWfsInput({ type: 'OGCFeatureServer' })).toBe(true)
    expect(isCsvInput({ layerType: 'CSVLayer' })).toBe(true)
  })

  it('不误判', () => {
    expect(isSceneInput({ layerType: 'FeatureLayer' })).toBe(false)
    expect(isWfsInput({ layerType: 'WMSLayer' })).toBe(false)
    expect(isMapInput({ layerType: 'GeoJSONLayer' })).toBe(false)
  })
})

describe('layerKindOf 完整分类', () => {
  it('按渲染分发顺序分类', () => {
    expect(layerKindOf({ url: 'https://x/MapServer' })).toBe('map')
    expect(layerKindOf({ layerType: 'ArcGISImageServiceLayer', url: 'https://x' })).toBe('image')
    expect(layerKindOf({ type: 'WMS', url: 'https://x' })).toBe('wms')
    expect(layerKindOf({ layerType: 'WMTSLayer', url: 'https://x' })).toBe('wmts')
    expect(layerKindOf({ layerType: 'VectorTileLayer' })).toBe('vector')
    expect(layerKindOf({ layerType: 'FeatureCollection', layerDefinition: { featureCollection: {} } })).toBe('feature')
    expect(layerKindOf({ layerType: 'SceneLayer' })).toBe('scene')
    expect(layerKindOf({ url: 'https://x/tileset.json' })).toBe('scene')
    expect(layerKindOf({ layerType: 'WFS' })).toBe('wfs')
    expect(layerKindOf({ layerType: 'CSVLayer' })).toBe('csv')
    expect(layerKindOf({ layerType: 'ArcGISFeatureLayer' })).toBe('feature')
    expect(layerKindOf({ layerType: 'GeoJSONLayer' })).toBe('geojson')
    expect(layerKindOf({ layerType: 'KMLLayer' })).toBe('kml')
  })

  it('未知类型与容器返回 null', () => {
    expect(layerKindOf({ layerType: 'Foo' })).toBeNull()
    expect(layerKindOf({})).toBeNull()
  })
})
