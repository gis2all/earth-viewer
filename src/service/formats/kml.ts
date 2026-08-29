

/**
 * 轻量 KML → GeoJSON 转换（只取点/线/面/MultiGeometry/gx:Track 与基础样式）。
 * 用途：让 KML 走统一 Worker 顶点/要素预算管线，防止大文件/复杂几何阻塞主线程或撑爆内存。
 * 保真度：保留 name/description 与 LineStyle/PolyStyle/IconStyle 基础颜色与图标；复杂样式/网络样式从简。
 * 注意：仅作预算管线输入，若解析失败/无要素，调用方应回退原生 Cesium.KmlDataSource.load。
 */
import type { FeatureStyleSpec } from '../../domain/types'

export interface KmlStyleSpec {
  iconHref?: string
  lineColor?: [number, number, number, number]
  lineWidth?: number
  fillColor?: [number, number, number, number]
  markerColor?: [number, number, number, number]
}

export interface KmlFeatureProperties {
  name?: string
  description?: string
  kmlStyle?: KmlStyleSpec
  [key: string]: unknown
}

export interface KmlGeoJsonFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown } | null
  properties: KmlFeatureProperties
}

export interface KmlGeoJson {
  type: 'FeatureCollection'
  features: KmlGeoJsonFeature[]
}

function byName(root: Element | Document, name: string): Element | null {
  const list = root.getElementsByTagNameNS('*', name)
  return list.length ? list[0] : null
}

function allByName(root: Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name))
}

function text(el: Element | null | undefined): string | undefined {
  const t = el?.textContent?.trim()
  return t ? t : undefined
}

function parseCoords(raw: string): [number, number][] {
  const out: [number, number][] = []
  for (const token of raw.trim().split(/\s+/)) {
    const p = token.split(',')
    const lon = Number(p[0])
    const lat = Number(p[1])
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat])
  }
  return out
}

function coordsOf(container: Element | null): [number, number][] | null {
  if (!container) return null
  const c = text(byName(container, 'coordinates'))
  return c ? parseCoords(c) : null
}

function parseKmlColor(raw?: string): [number, number, number, number] | undefined {
  if (!raw) return undefined
  const s = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{8}$/.test(s)) return undefined
  const a = parseInt(s.slice(0, 2), 16)
  const b = parseInt(s.slice(2, 4), 16)
  const g = parseInt(s.slice(4, 6), 16)
  const r = parseInt(s.slice(6, 8), 16)
  return [r, g, b, a]
}

function styleFromElement(el: Element | null): KmlStyleSpec | undefined {
  if (!el) return undefined
  const st: KmlStyleSpec = {}
  const line = byName(el, 'LineStyle')
  if (line) {
    const c = parseKmlColor(text(byName(line, 'color')))
    if (c) st.lineColor = c
    const w = Number(text(byName(line, 'width')))
    if (Number.isFinite(w) && w > 0) st.lineWidth = w
  }
  const poly = byName(el, 'PolyStyle')
  if (poly) {
    const c = parseKmlColor(text(byName(poly, 'color')))
    if (c) st.fillColor = c
  }
  const icon = byName(el, 'IconStyle')
  if (icon) {
    const c = parseKmlColor(text(byName(icon, 'color')))
    if (c) st.markerColor = c
    const href = text(byName(icon, 'href'))
    if (href) st.iconHref = href
  }
  return Object.keys(st).length ? st : undefined
}

function buildStyleMap(doc: Document): Map<string, KmlStyleSpec> {
  const map = new Map<string, KmlStyleSpec>()
  for (const style of allByName(doc.documentElement, 'Style')) {
    const id = style.getAttribute('id')
    if (!id) continue
    const spec = styleFromElement(style)
    if (spec) map.set('#' + id, spec)
  }
  for (const sm of allByName(doc.documentElement, 'StyleMap')) {
    const id = sm.getAttribute('id')
    if (!id) continue
    const pairs = allByName(sm, 'Pair')
    const normal = pairs.find((p) => text(byName(p, 'key')) === 'normal')
    const url = text(byName(normal ?? pairs[0], 'styleUrl'))
    if (url && map.has(url)) map.set('#' + id, map.get(url)!)
  }
  return map
}

function resolveStyle(placemark: Element, styles: Map<string, KmlStyleSpec>): KmlStyleSpec | undefined {
  const url = text(byName(placemark, 'styleUrl'))
  if (url && styles.has(url)) return styles.get(url)
  return styleFromElement(allByName(placemark, 'Style')[0] ?? null)
}

function pointGeometry(el: Element): { type: 'Point'; coordinates: [number, number] } | null {
  const c = coordsOf(el)
  return c && c.length ? { type: 'Point', coordinates: c[0] } : null
}

function lineGeometry(el: Element): { type: 'LineString'; coordinates: [number, number][] } | null {
  const c = coordsOf(el)
  return c && c.length >= 2 ? { type: 'LineString', coordinates: c } : null
}

function ringFromLinearRing(container: Element | null): [number, number][] | null {
  if (!container) return null
  const ring = byName(container, 'LinearRing')
  return coordsOf(ring)
}

function polygonGeometry(el: Element): { type: 'Polygon'; coordinates: [number, number][][] } | null {
  const outerEl = byName(el, 'outerBoundaryIs')
  const outer = ringFromLinearRing(outerEl)
  if (!outer || outer.length < 4) return null
  const coords: [number, number][][] = [outer]
  for (const innerEl of allByName(el, 'innerBoundaryIs')) {
    const ring = ringFromLinearRing(innerEl)
    if (ring && ring.length >= 4) coords.push(ring)
  }
  return { type: 'Polygon', coordinates: coords }
}

function trackGeometry(el: Element): { type: 'LineString'; coordinates: [number, number][] } | null {
  const coords: [number, number][] = []
  for (const gc of allByName(el, 'coord')) {
    const p = text(gc)?.trim().split(/\s+/)
    const lon = Number(p?.[0])
    const lat = Number(p?.[1])
    if (Number.isFinite(lon) && Number.isFinite(lat)) coords.push([lon, lat])
  }
  return coords.length >= 2 ? { type: 'LineString', coordinates: coords } : null
}

type GeoJsonGeometry = { type: string; coordinates: unknown }

function combineMulti(gs: GeoJsonGeometry[]): GeoJsonGeometry | null {
  if (!gs.length) return null
  const types = new Set(gs.map((g) => g.type))
  if (types.size === 1) {
    const t = [...types][0]
    // 若子类型本身是 Multi* （嵌套 MultiGeometry），平铺合并而非再嵌一层
    if (t.startsWith('Multi')) {
      const coords: unknown[] = []
      for (const g of gs) coords.push(...(g.coordinates as unknown[]))
      return { type: t, coordinates: coords }
    }
    return { type: 'Multi' + t, coordinates: gs.map((g) => g.coordinates) }
  }
  return gs[0]
}

function multiGeometry(el: Element): GeoJsonGeometry | null {
  const gs: GeoJsonGeometry[] = []
  for (const child of Array.from(el.children)) {
    const g = singleGeometry(child)
    if (g) gs.push(g)
  }
  return combineMulti(gs)
}

function singleGeometry(el: Element): GeoJsonGeometry | null {
  const lname = el.localName || el.nodeName.replace(/^.*:/, '')
  if (lname === 'Point') return pointGeometry(el)
  if (lname === 'LineString') return lineGeometry(el)
  if (lname === 'Polygon') return polygonGeometry(el)
  if (lname === 'MultiGeometry') return multiGeometry(el)
  return null
}

function geometryFromPlacemark(pm: Element): GeoJsonGeometry | null {
  const track = byName(pm, 'Track')
  if (track) return trackGeometry(track)
  const multi = byName(pm, 'MultiGeometry')
  if (multi) return multiGeometry(multi)
  for (const child of Array.from(pm.children)) {
    const lname = child.localName || child.nodeName.replace(/^.*:/, '')
    if (lname === 'Point' || lname === 'LineString' || lname === 'Polygon') {
      const g = singleGeometry(child)
      if (g) return g
    }
  }
  return null
}

function placemarkToFeature(pm: Element, styles: Map<string, KmlStyleSpec>): KmlGeoJsonFeature | null {
  const geometry = geometryFromPlacemark(pm)
  if (!geometry) return null
  const props: KmlFeatureProperties = {}
  const name = text(byName(pm, 'name'))
  if (name) props.name = name
  const desc = text(byName(pm, 'description'))
  if (desc) props.description = desc
  const style = resolveStyle(pm, styles)
  if (style) props.kmlStyle = style
  return { type: 'Feature', geometry, properties: props }
}

/**
 * 解析 KML 文本为 GeoJSON FeatureCollection（仅精简基础几何与样式）。
 * 解析失败/无合法要素时返回空的 FeatureCollection。
 */
export function parseKmlToGeoJSON(kmlText: string): KmlGeoJson {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml')
  const parseError = doc.getElementsByTagName('parsererror')
  if (parseError.length) return { type: 'FeatureCollection', features: [] }
  const root = doc.documentElement
  if (!root) return { type: 'FeatureCollection', features: [] }
  const styles = buildStyleMap(doc)
  const features: KmlGeoJsonFeature[] = []
  for (const pm of allByName(root, 'Placemark')) {
    const f = placemarkToFeature(pm, styles)
    if (f) features.push(f)
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 把 KML 样式转换为 Cesium 通用 FeatureStyleSpec，便于 applyFeatureStyler 渲染。
 */
export function kmlStyleToFeatureStyle(kmlStyle?: KmlStyleSpec): FeatureStyleSpec | undefined {
  if (!kmlStyle) return undefined
  const out: FeatureStyleSpec = {}
  if (kmlStyle.markerColor) out.markerColor = kmlStyle.markerColor
  if (kmlStyle.lineColor) {
    out.stroke = kmlStyle.lineColor
    if (kmlStyle.lineWidth) out.strokeWidth = kmlStyle.lineWidth
  }
  if (kmlStyle.fillColor) out.fill = kmlStyle.fillColor
  return Object.keys(out).length ? out : undefined
}
