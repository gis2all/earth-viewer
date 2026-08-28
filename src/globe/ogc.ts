import { withFetchTimeout, type WebLayer } from './facade/webmap'
import { SAFETY } from './loadSafety'

type FeatureCollection = {
  type: 'FeatureCollection'
  features: unknown[]
  [key: string]: unknown
}

function withParams(url: string, params: Record<string, string>): string {
  const target = new URL(url, window.location.origin)
  Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value))
  return target.toString()
}

async function readJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: withFetchTimeout(signal) })
  if (!response.ok) throw new Error('OGC 要素服务请求失败')
  return (await response.json()) as Record<string, unknown>
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((value as { features?: unknown }).features)
  )
}

function firstCollectionId(value: Record<string, unknown>): string | undefined {
  const collections = value.collections
  if (!Array.isArray(collections)) return undefined
  const collection = collections.find((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
  return collection ? (collection as { id: string }).id : undefined
}

function firstWfsTypeName(xml: string): string | undefined {
  const match = xml.match(/<(?:\w+:)?Name>\s*([^<\s]+)\s*<\/(?:\w+:)?Name>/i)
  return match?.[1]
}

async function fetchWfsGeoJSON(url: string, preferredTypeName?: string, signal?: AbortSignal): Promise<FeatureCollection> {
  const capabilitiesUrl = withParams(url, {
    service: 'WFS',
    request: 'GetCapabilities',
    version: '2.0.0',
  })
  const capabilities = await fetch(capabilitiesUrl, { signal: withFetchTimeout(signal) })
  if (!capabilities.ok) throw new Error('WFS GetCapabilities 请求失败')
  const typeName = preferredTypeName || firstWfsTypeName(await capabilities.text())
  if (!typeName) throw new Error('WFS 未找到要素类型')

  const featureUrl = withParams(url, {
    service: 'WFS',
    request: 'GetFeature',
    version: '2.0.0',
    typeNames: typeName,
    outputFormat: 'application/json',
    srsName: 'CRS:84',
    count: String(SAFETY.MAX_FEATURES),
  })
  const result = await readJson(featureUrl, signal)
  if (!isFeatureCollection(result)) throw new Error('WFS 未返回 GeoJSON')
  return result
}

async function fetchOgcApiGeoJSON(url: string, signal?: AbortSignal): Promise<FeatureCollection> {
  const normalized = url.replace(/\/+$/, '')
  if (/\/items$/i.test(normalized)) {
    const result = await readJson(withParams(normalized, { f: 'geojson', limit: String(SAFETY.MAX_FEATURES) }), signal)
    if (!isFeatureCollection(result)) throw new Error('OGC API 未返回 GeoJSON')
    return result
  }

  if (/\/collections\/[^/]+$/i.test(normalized)) {
    const result = await readJson(withParams(normalized + '/items', { f: 'geojson', limit: String(SAFETY.MAX_FEATURES) }), signal)
    if (!isFeatureCollection(result)) throw new Error('OGC API 未返回 GeoJSON')
    return result
  }

  const collections = await readJson(withParams(normalized + '/collections', { f: 'json' }), signal)
  const collectionId = firstCollectionId(collections)
  if (!collectionId) throw new Error('OGC API 未找到要素集合')
  const result = await readJson(
    withParams(normalized + '/collections/' + encodeURIComponent(collectionId) + '/items', {
      f: 'geojson',
      limit: String(SAFETY.MAX_FEATURES),
    }),
    signal
  )
  if (!isFeatureCollection(result)) throw new Error('OGC API 未返回 GeoJSON')
  return result
}

/** 读取标准 WFS / OGC API Features，并统一转换为 Cesium 可加载的 GeoJSON。 */
export async function fetchOgcFeatureGeoJSON(
  url: string,
  layer?: Pick<WebLayer, 'type' | 'layerType' | 'layerName' | 'name' | 'typeName' | 'collectionId'>,
  signal?: AbortSignal
): Promise<FeatureCollection> {
  const kind = layer?.type || layer?.layerType || ''
  const collectionId = layer?.collectionId || layer?.layerName || layer?.name
  const typeName = layer?.typeName || layer?.layerName || layer?.name
  if (/^WFS$|WFS/i.test(kind) || /\/wfs(?:\/|$)/i.test(url)) {
    return fetchWfsGeoJSON(url, typeName, signal)
  }
  const base = url.replace(/\/+$/, '')
  if (collectionId && !/\/collections\/[^/]+$/i.test(base) && !/\/items$/i.test(base)) {
    return fetchOgcApiGeoJSON(base + '/collections/' + encodeURIComponent(collectionId), signal)
  }
  return fetchOgcApiGeoJSON(url, signal)
}
