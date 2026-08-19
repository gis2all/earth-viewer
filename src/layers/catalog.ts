import type { LayerDef } from './types'

export const catalog: LayerDef[] = [
  { id: 'terrain', name: '地形', group: 'terrain', category: 'base', type: 'terrain', thumb: 'terrain', desc: 'GEBCO · SRTM' },
  { id: 'imagery', name: '卫星影像', group: 'terrain', category: 'base', type: 'imagery', thumb: 'imagery', desc: 'Blue Marble' },
  { id: 'night', name: '夜间灯光', group: 'terrain', category: 'base', type: 'imagery', thumb: 'night', desc: 'VIIRS' },
  { id: 'boundary', name: '行政边界', group: 'human', category: 'overlay', type: 'geojson', thumb: 'boundary', desc: 'Natural Earth' },
  { id: 'population', name: '人口密度', group: 'human', category: 'overlay', type: 'raster', thumb: 'population', desc: 'WorldPop' },
  { id: 'landuse', name: '土地利用', group: 'environment', category: 'overlay', type: 'raster', thumb: 'landuse', desc: 'ESA' },
  { id: 'weather', name: '气象', group: 'weather', category: 'overlay', type: 'timeseries', thumb: 'weather', temporal: true, desc: 'ERA5' },
  { id: 'quakes', name: '地震', group: 'geology', category: 'overlay', type: 'timeseries', thumb: 'quakes', temporal: true, desc: 'USGS' },
]