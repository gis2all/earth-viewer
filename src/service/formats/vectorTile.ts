import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { withFetchTimeout } from '../http'
import type { WebLayer } from '../../domain/types'

/** 单条解码后的矢量要素（geometry 为瓦片局部坐标，需用瓦片 z/y/x 转成经纬度） */
export interface VectorTileFeature {
  layerName: string
  type: number
  properties: Record<string, unknown>
  geometry: unknown
}

/** 解码已解析的 VectorTile 的图层与要素（纯函数，便于单测） */
export function decodeVectorTileLayers(tile: { layers: Record<string, { length: number; feature: (i: number) => { type: number; properties?: Record<string, unknown>; toGeoJSON: (x: number, y: number, z: number) => { geometry?: unknown } } }> }, x = 0, y = 0, z = 0): VectorTileFeature[] {
  const out: VectorTileFeature[] = []
  for (const layerName of Object.keys(tile.layers)) {
    const layer = tile.layers[layerName]
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      out.push({
        layerName,
        type: f.type,
        properties: f.properties ?? {},
        // toGeoJSON(x,y,z) 用瓦片坐标把几何转成 WGS84 经纬度
        geometry: f.toGeoJSON(x, y, z).geometry ?? null,
      })
    }
  }
  return out
}

/** 拉取一张 MVT 瓦片并解码为 FeatureCollection（geometry 已转成 WGS84） */
export async function fetchVectorTileGeoJSON(tileUrl: string, z: number, y: number, x: number, signal?: AbortSignal): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
  const r = await fetch(tileUrl, { signal: withFetchTimeout(signal) })
  if (!r.ok) throw new Error('矢量瓦片加载失败')
  const buf = new Uint8Array(await r.arrayBuffer())
  const pbf = new PbfReader(buf)
  const tile = new VectorTile(pbf as never)
  const feats = decodeVectorTileLayers(tile as never, x, y, z)
  return {
    type: 'FeatureCollection',
    features: feats.map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry })),
  }
}

/** 把 ArcGIS VectorTileServer 拼成 Cesium MVT 模板或单张瓦片 URL */
export function vectorTileUrl(baseUrl: string, z?: number, y?: number, x?: number): string {
  const suffix = z === undefined || y === undefined || x === undefined
    ? '{z}/{y}/{x}'
    : z + '/' + y + '/' + x
  return baseUrl.replace(/\/?$/, '') + '/tile/' + suffix + '.pbf'
}

/** 把 ArcGIS 常用的 /{z}/{y}/{x} 模板转换为 Cesium MVT 的 /{z}/{x}/{y} 顺序。 */
export function toCesiumMvtTemplate(template: string): string {
  return template.replace(/\{z\}\/\{y\}\/\{x\}/gi, '{z}/{x}/{y}')
}

/** 读取 VectorTileLayer 自身 URL 或 WebScene style.json 中的全部 MVT 源。 */
export async function fetchVectorTileTemplates(
  layer: Pick<WebLayer, 'url' | 'styleUrl'>,
  signal?: AbortSignal
): Promise<string[]> {
  const resolveTemplate = (value: string) =>
    new URL(value, layer.styleUrl).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
  const templates: string[] = []
  if (layer.url) {
    templates.push(/\/VectorTileServer\/?$/i.test(layer.url) ? vectorTileUrl(layer.url) : layer.url)
  }
  if (layer.styleUrl) {
    try {
      const response = await fetch(layer.styleUrl, { signal: withFetchTimeout(signal) })
      if (response.ok) {
        const style = (await response.json()) as {
          sources?: Record<string, { url?: string; tiles?: string[] }>
        }
        for (const source of Object.values(style.sources ?? {})) {
          const tile = source.tiles?.find((value) => typeof value === 'string')
          if (tile) {
            templates.push(resolveTemplate(tile))
            continue
          }
          if (source.url) {
            const sourceUrl = resolveTemplate(source.url)
            templates.push(/\/VectorTileServer\/?$/i.test(sourceUrl) ? vectorTileUrl(sourceUrl) : sourceUrl)
          }
        }
      }
    } catch {
      // style 失败时仍保留 layer.url 直连模板
    }
  }
  return [...new Set(templates)]
}

/**
 * 给 MVTDataProvider 背靠的 Cesium3DTileset 设置缓存内存上限。
 * Cesium 会在 cacheBytes 超限且瓦片不在视口内时自动卸载该瓦片内容（就是业界 memoryLimitMB 模式）。
 * 返回是否成功设置（provider 尚无 tileset 时为 false）。
 */
export function applyVectorTileMemoryLimit(
  provider: { tileset?: { cacheBytes: number; maximumCacheOverflowBytes: number } | null | undefined } | null | undefined,
  limitBytes: number,
  overflowBytes?: number
): boolean {
  const tileset = provider?.tileset
  if (!tileset) return false
  tileset.cacheBytes = limitBytes
  if (typeof overflowBytes === 'number' && overflowBytes >= 0) tileset.maximumCacheOverflowBytes = overflowBytes
  return true
}
