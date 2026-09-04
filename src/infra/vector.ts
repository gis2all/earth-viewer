import proj4 from 'proj4'
import * as Cesium from 'cesium'
import { withFetchTimeout } from '../service/http'
import type { FeatureStyleSpec } from '../domain/types'

// 常见 ArcGIS Web Mercator wkid 与 EPSG:3857 等价（部分服务用旧 wkid 102100/102113）
proj4.defs('EPSG:102100', proj4.defs('EPSG:3857'))
proj4.defs('EPSG:102113', proj4.defs('EPSG:3857'))
// 荷兰 Rijksdriehoeks（RD New）本地图层常用 28992，proj4 默认不含需显式注册
proj4.defs('EPSG:28992', '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +units=m +no_defs')

/** 递归重投影一组坐标（支持任意嵌套深度的 [x,y] / ring / polygon 数组） */
export function reprojectCoordinates(
  coords: unknown,
  from: string,
  to: string,
  maxDepth = 8
): unknown {
  if (maxDepth <= 0) return coords
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    const arr = coords as number[]
    if (arr.length < 2) return arr
    // proj4.forward(input: [x, y]) → [x, y]
    const [x, y] = proj4(from, to, [arr[0], arr[1]] as [number, number])
    return [x, y, ...arr.slice(2)]
  }
  if (Array.isArray(coords)) {
    return coords.map((c) => reprojectCoordinates(c, from, to, maxDepth - 1))
  }
  return coords
}

/** 依据 GeoJSON 的 crs 属性或给定 wkid，将 FeatureCollection 重投影到 WGS84（in-place 返回新对象） */
export function reprojectFeatureCollection<T extends { features?: unknown[] }>(
  fc: T,
  fromWkid?: number
): T {
  const wkid = fromWkid ?? crsWkidFromGeoJson(fc as Record<string, unknown>)
  if (!wkid || wkid === 4326) return fc
  const from = 'EPSG:' + wkid
  const to = 'EPSG:4326'
  if (!proj4.defs(from)) return fc // 未知投影，保持原样（避免误转）
  const features = (fc.features as (Record<string, unknown> & { geometry?: { coordinates?: unknown } })[]) ?? []
  for (const f of features) {
    const g = f.geometry as { coordinates?: unknown } | undefined
    if (g?.coordinates) g.coordinates = reprojectCoordinates(g.coordinates as number[], from, to)
  }
  return fc
}

/** 从 GeoJSON 的 crs 属性读取 EPSG wkid（RFC7946 urn:ogc:def:crs:EPSG::4326 等） */
export function crsWkidFromGeoJson(json: Record<string, unknown>): number | undefined {
  const crs = json.crs as { properties?: { name?: string }; type?: string } | undefined
  if (!crs?.properties?.name) return undefined
  const m = /EPSG::(\d+)/.exec(crs.properties.name)
  return m ? Number(m[1]) : undefined
}

/** 探测服务 wkid（复用 CRS 探测，但独立缓存避免与 webmap 抢占） */
const SR_CACHE = new Map<string, number>()
export async function detectServiceWkid(url: string): Promise<number | undefined> {
  const base = url.replace(/\/?$/, '')
  const cached = SR_CACHE.get(base)
  if (cached) return cached
  try {
    const r = await fetch(base + '?f=json', { signal: withFetchTimeout() })
    if (!r.ok) return undefined
    const j = (await r.json()) as { spatialReference?: { wkid?: number; latestWkid?: number } }
    const wkid = j.spatialReference?.wkid ?? j.spatialReference?.latestWkid
    if (typeof wkid === 'number') SR_CACHE.set(base, wkid)
    return typeof wkid === 'number' ? wkid : undefined
  } catch {
    return undefined
  }
}


// ---- Feature Service renderer -> per-feature style ----

export interface ArcGISSymbol {
  type?: string
  color?: number[]
  size?: number
  width?: number
  outline?: { color?: number[]; width?: number }
}

function toColor(c?: number[]): [number, number, number, number] | undefined {
  if (!c || c.length < 3) return undefined
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), c.length >= 4 ? Math.round(c[3]) : 255]
}

function symbolToStyle(sym?: ArcGISSymbol): FeatureStyleSpec {
  if (!sym) return {}
  if (sym.type === 'esriSMS') {
    return { markerColor: toColor(sym.color), markerSize: sym.size }
  }
  if (sym.type === 'esriSLS') {
    return { stroke: toColor(sym.color), strokeWidth: sym.width }
  }
  if (sym.type === 'esriSFS') {
    return {
      fill: toColor(sym.color),
      stroke: toColor(sym.outline?.color),
      strokeWidth: sym.outline?.width,
    }
  }
  return {}
}

function nonEmpty(style: FeatureStyleSpec): FeatureStyleSpec | undefined {
  return Object.keys(style).length ? style : undefined
}

/**
 * ArcGIS drawingInfo.renderer -> a function mapping feature properties to a Cesium-friendly style spec.
 * Supports simple / uniqueValue / classBreaks; returns undefined for unsupported renderers.
 */
export function rendererToStyleFn(renderer?: Record<string, unknown>): (props?: Record<string, unknown>) => FeatureStyleSpec | undefined {
  if (!renderer) return () => undefined
  const type = String(renderer.type ?? '')
  const sym = renderer.symbol as ArcGISSymbol | undefined

  if (type === 'simple') {
    const style = symbolToStyle(sym)
    return () => nonEmpty(style)
  }
  if (type === 'uniqueValue') {
    const field = String(renderer.field1 ?? renderer.field ?? '')
    const infos = (renderer.uniqueValueInfos as { value?: unknown; symbol?: ArcGISSymbol }[] | undefined) ?? []
    return (props) => {
      const val = props?.[field]
      const info = infos.find((i) => String(i.value) === String(val))
      return info ? nonEmpty(symbolToStyle(info.symbol)) : undefined
    }
  }
  if (type === 'classBreaks') {
    const field = String(renderer.field ?? '')
    const infos = (renderer.classBreakInfos as { classMaxValue?: number; symbol?: ArcGISSymbol }[] | undefined) ?? []
    return (props) => {
      const val = Number(props?.[field])
      if (Number.isNaN(val)) return undefined
      const info = infos.find((i) => val <= Number(i.classMaxValue))
      return info ? nonEmpty(symbolToStyle(info.symbol)) : undefined
    }
  }
  return () => undefined
}


/** Read a Cesium Entity.properties bag (or a plain object) into a plain record. */
export function readEntityProps(props: unknown): Record<string, unknown> {
  if (!props) return {}
  if (typeof props === 'object' && 'getValue' in (props as object)) {
    try {
      return (props as { getValue: (t?: unknown) => Record<string, unknown> }).getValue(Cesium.JulianDate.now())
    } catch {
      return (props as Record<string, unknown>)
    }
  }
  return props as Record<string, unknown>
}

function toCesiumColor(c?: [number, number, number, number]): Cesium.Color | undefined {
  return c ? Cesium.Color.fromBytes(c[0], c[1], c[2], c[3]) : undefined
}

/**
 * Apply a per-feature style function to a loaded GeoJsonDataSource's entities.
 * Handles polygon / polyline / point geometry entities; no-ops when styleFn returns undefined.
 */
export function applyFeatureStyler(
  ds: { entities?: { values?: unknown[] } },
  styleFn: (props?: Record<string, unknown>) => FeatureStyleSpec | undefined
): void {
  const values = ((ds.entities?.values ?? []) as Array<Record<string, unknown>>)
  for (const entity of values) {
    const style = styleFn(readEntityProps(entity.properties))
    if (!style) continue
    if (style.fill) {
      const polygon = entity.polygon as { material?: unknown } | undefined
      if (polygon) polygon.material = toCesiumColor(style.fill)
    }
    if (style.stroke) {
      const polygon = entity.polygon as { outlineColor?: unknown; outlineWidth?: number } | undefined
      if (polygon) {
        polygon.outlineColor = toCesiumColor(style.stroke)
        polygon.outlineWidth = style.strokeWidth ?? 1
      }
      const polyline = entity.polyline as { material?: unknown; width?: number } | undefined
      if (polyline) {
        polyline.material = toCesiumColor(style.stroke)
        polyline.width = style.strokeWidth ?? 1
      }
    }
    if (style.markerColor) {
      const point = entity.point as { color?: unknown; pixelSize?: number } | undefined
      if (point) {
        point.color = toCesiumColor(style.markerColor)
        if (style.markerSize) point.pixelSize = style.markerSize
      }
    }
  }
}
