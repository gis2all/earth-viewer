// ArcGIS Online item types supported as independent search results.
// Service items carry a service URL; file items (GeoJson/CSV) are fetched via /items/<id>/data.
export const SEARCH_ITEM_TYPES = [
  'Web Map',
  'Web Scene',
  'Map Service',
  'Feature Service',
  'Image Service',
  'Scene Service',
  'KML',
  'Vector Tile Service',
  'WMS',
  'WMTS',
  'WFS',
  'GeoJson',
  'CSV',
] as const

// Web Map / Web Scene are containers: they hold multiple layers and need /items/<id>/data
export function isWebMapContainer(type: string): boolean {
  return type === 'Web Map' || type === 'Web Scene'
}

// Service item type -> webmap layerType (wrap the service item as a single layer, reusing existing renderers)
export function layerTypeForItemType(type: string): string | undefined {
  switch (type) {
    case 'Map Service': return 'ArcGISMapServiceLayer'
    case 'Feature Service': return 'ArcGISFeatureLayer'
    case 'Image Service': return 'ArcGISImageServiceLayer'
    case 'Scene Service': return 'ArcGISSceneServiceLayer'
    case 'KML': return 'KMLLayer'
    case 'Vector Tile Service': return 'VectorTileLayer'
    case 'WMS': return 'WMSLayer'
    case 'WMTS': return 'WMTSLayer'
    case 'WFS': return 'WFS'
    case 'GeoJson': return 'GeoJSONLayer'
    case 'CSV': return 'CSVLayer'
    default: return undefined
  }
}
