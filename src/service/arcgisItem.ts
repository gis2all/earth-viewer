import { withFetchTimeout } from './http'
import { fetchSceneLayerKinds, isPointCloudScene } from './repository'
import type { WebLayer } from '../domain/types'
import { layerTypeForItemType } from '../domain/itemTypes'

export interface ServiceItemInput {
  id: string
  type: string
  url?: string
  title?: string
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  Object.entries(params).forEach(([key, value]) => u.searchParams.set(key, value))
  return u.toString()
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '')
}

async function readText(url: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(url, { signal: withFetchTimeout(signal) })
  if (!r.ok) throw new Error('service metadata request failed')
  return r.text()
}

// WMS capabilities: first <Layer><Name> inside <Capability>
function firstWmsLayerName(xml: string): string | undefined {
  const match = xml.match(/Capability[\s\S]*?<Layer\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/i)
  return match?.[1]?.trim()
}

function firstIdentifier(xml: string, tag: string): string | undefined {
  const re = new RegExp('<' + tag + '[^>]*>[\\s\\S]*?<ows:Identifier>([^<]+)</ows:Identifier>', 'i')
  const m = xml.match(re)
  return m?.[1]?.trim()
}

export interface WmtsConfig {
  layer?: string
  tileMatrixSet?: string
  style?: string
  format?: string
}

async function resolveWmtsCapabilities(url: string, signal?: AbortSignal): Promise<WmtsConfig> {
  const xml = await readText(withQuery(normalizeBase(url), { service: 'WMTS', request: 'GetCapabilities' }), signal)
  return {
    layer: firstIdentifier(xml, 'Layer'),
    tileMatrixSet: firstIdentifier(xml, 'TileMatrixSet'),
    style: firstIdentifier(xml, 'Style'),
    format: xml.match(/<Format>([^<]+)<\/Format>/i)?.[1]?.trim() || 'image/png',
  }
}

// ArcGIS WMTS item url is often a GetTile template with LAYER/STYLE/FORMAT/TILEMATRIXSET already in the query.
function wmtsFromTemplate(url: string): WmtsConfig & { serviceBase: string } {
  const u = new URL(url)
  const layer = u.searchParams.get('LAYER') || u.searchParams.get('layer')
  const style = u.searchParams.get('STYLE') || u.searchParams.get('style') || u.searchParams.get('Style')
  const format = u.searchParams.get('FORMAT') || u.searchParams.get('format')
  const tileMatrixSet = u.searchParams.get('TILEMATRIXSET') || u.searchParams.get('tileMatrixSet')
  return { layer: layer || undefined, style: style || undefined, format: format || undefined, tileMatrixSet: tileMatrixSet || undefined, serviceBase: u.origin + u.pathname }
}

// Turn a search result item into a WebLayer that the existing GlobeViewer renderers can consume.
export async function resolveServiceItem(it: ServiceItemInput, signal?: AbortSignal): Promise<WebLayer | null> {
  const layerType = layerTypeForItemType(it.type)
  if (!layerType) return null
  const base: WebLayer = { title: it.title, url: it.url, layerType }
  switch (it.type) {
    case 'WMS': {
      if (!it.url) return null
      const cap = withQuery(normalizeBase(it.url), { service: 'WMS', request: 'GetCapabilities' })
      return { ...base, layerName: await firstWmsLayerName(await readText(cap, signal)) }
    }
    case 'WMTS': {
      if (!it.url) return null
      const tpl = wmtsFromTemplate(it.url)
      if (tpl.layer) {
        return { ...base, url: tpl.serviceBase, layerName: tpl.layer, tileMatrixSetID: tpl.tileMatrixSet, style: tpl.style, format: tpl.format || 'image/png' }
      }
      try {
        const cfg = await resolveWmtsCapabilities(it.url, signal)
        if (cfg.layer) return { ...base, layerName: cfg.layer, tileMatrixSetID: cfg.tileMatrixSet, style: cfg.style, format: cfg.format }
      } catch {
        // fall through
      }
      // Unable to resolve WMTS config -> keep service base; renderer degrades instead of failing the add.
      return { ...base, url: normalizeBase(it.url) }
    }
    case 'Vector Tile Service':
      if (!it.url) return null
      return { ...base, styleUrl: normalizeBase(it.url) + '/resources/styles/root.json' }
    case 'WFS':
      return it.url ? base : null
    case 'GeoJson':
    case 'CSV':
      return { ...base, url: '/sharing/rest/content/items/' + it.id + '/data' }
    default:
      if (it.type === 'Scene Service' && it.url) {
        // 点云场景（Point/PointCloud/Splat）：Cesium I3SDataProvider 不渲染，直接拦截不让添加
        const kinds = await fetchSceneLayerKinds(it.url, signal)
        if (isPointCloudScene(kinds)) return null
      }
      return it.url ? base : null
  }
}
