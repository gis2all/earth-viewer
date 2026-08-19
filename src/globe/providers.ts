import * as Cesium from 'cesium'
import type { LayerDef } from '../layers/types'

const GIBS_BLUE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
const GIBS_NIGHT =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/** 每次返回全新的 ImageryLayer（避免实例复用触发 Cesium DeveloperError） */
export function baseLayerFor(base: LayerDef | undefined): Cesium.ImageryLayer {
  const url = !base
    ? OSM
    : base.id === 'imagery'
      ? GIBS_BLUE
      : base.id === 'night'
        ? GIBS_NIGHT
        : OSM
  return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url }))
}
