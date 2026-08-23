import { describe, it, expect } from 'vitest'
import { SEARCH_ITEM_TYPES, isWebMapContainer, layerTypeForItemType } from './itemTypes'

describe('itemTypes', () => {
  it('whitelist includes containers and directly renderable service types', () => {
    expect(SEARCH_ITEM_TYPES).toContain('Web Map')
    expect(SEARCH_ITEM_TYPES).toContain('Web Scene')
    expect(SEARCH_ITEM_TYPES).toContain('Map Service')
    expect(SEARCH_ITEM_TYPES).toContain('Feature Service')
    expect(SEARCH_ITEM_TYPES).toContain('Image Service')
    expect(SEARCH_ITEM_TYPES).toContain('Scene Service')
    expect(SEARCH_ITEM_TYPES).toContain('KML')
    expect(SEARCH_ITEM_TYPES).toContain('Vector Tile Service')
    expect(SEARCH_ITEM_TYPES).toContain('WMS')
    expect(SEARCH_ITEM_TYPES).toContain('WMTS')
    expect(SEARCH_ITEM_TYPES).toContain('WFS')
    expect(SEARCH_ITEM_TYPES).toContain('GeoJson')
    expect(SEARCH_ITEM_TYPES).toContain('CSV')
  })

  it('Web Map / Web Scene are containers, others are services', () => {
    expect(isWebMapContainer('Web Map')).toBe(true)
    expect(isWebMapContainer('Web Scene')).toBe(true)
    expect(isWebMapContainer('Map Service')).toBe(false)
    expect(isWebMapContainer('KML')).toBe(false)
  })

  it('service types map to webmap layerType', () => {
    expect(layerTypeForItemType('Map Service')).toBe('ArcGISMapServiceLayer')
    expect(layerTypeForItemType('Feature Service')).toBe('ArcGISFeatureLayer')
    expect(layerTypeForItemType('Image Service')).toBe('ArcGISImageServiceLayer')
    expect(layerTypeForItemType('Scene Service')).toBe('ArcGISSceneServiceLayer')
    expect(layerTypeForItemType('KML')).toBe('KMLLayer')
    expect(layerTypeForItemType('Vector Tile Service')).toBe('VectorTileLayer')
    expect(layerTypeForItemType('WMS')).toBe('WMSLayer')
    expect(layerTypeForItemType('WMTS')).toBe('WMTSLayer')
    expect(layerTypeForItemType('WFS')).toBe('WFS')
    expect(layerTypeForItemType('GeoJson')).toBe('GeoJSONLayer')
    expect(layerTypeForItemType('CSV')).toBe('CSVLayer')
  })

  it('unknown type does not map layerType', () => {
    expect(layerTypeForItemType('Streaming Service')).toBeUndefined()
  })
})
