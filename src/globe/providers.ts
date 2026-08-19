import * as Cesium from 'cesium'
import type { LayerDef } from '../layers/types'

const GIBS_BLUE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
const GIBS_NIGHT =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

const cache = new Map<string, Cesium.ImageryLayer>()

function layer(url: string): Cesium.ImageryLayer {
  const hit = cache.get(url)
  if (hit) return hit
  const l = new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url }))
  cache.set(url, l)
  return l
}

/** 根据当前基底返回对应影像层 */
export function baseLayerFor(base: LayerDef | undefined): Cesium.ImageryLayer {
  if (!base) return layer(OSM)
  switch (base.id) {
    case 'imagery':
      return layer(GIBS_BLUE)
    case 'night':
      return layer(GIBS_NIGHT)
    default:
      return layer(OSM)
  }
}
