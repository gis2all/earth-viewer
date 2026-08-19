export type LayerGroup = 'terrain' | 'human' | 'environment' | 'weather' | 'geology'
export type LayerCategory = 'base' | 'overlay'
export type LayerType = 'terrain' | 'imagery' | 'geojson' | 'raster' | 'timeseries'

export interface LayerDef {
  id: string
  name: string
  group: LayerGroup
  category: LayerCategory
  type: LayerType
  temporal?: boolean
  desc?: string
  thumb: string
}