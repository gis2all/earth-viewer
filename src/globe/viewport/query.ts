import type { ViewEnvelope, FeatureQueryOptions } from './featureQuery'
import { buildFeatureQueryUrl, parseFeatureCollection } from './featureQuery'
import { runViewportProcess } from './worker'
import type { ViewportProcessResult } from './process'
import { withFetchTimeout } from '../webmap'

export interface ViewportQueryOptions extends FeatureQueryOptions {
  maxVertices?: number
}

/** 视口驱动查询：按当前视口 envelope 向 ArcGIS FeatureServer/MapServer 拉取可见数据，再走抽稀/预算管线。 */
export async function queryViewportData(
  serviceUrl: string,
  env: ViewEnvelope,
  opts: ViewportQueryOptions = {},
  signal?: AbortSignal
): Promise<ViewportProcessResult> {
  const url = buildFeatureQueryUrl(serviceUrl, env, opts)
  const r = await fetch(url, { signal: withFetchTimeout(signal) })
  if (!r.ok) throw new Error('ArcGIS 视口查询失败')
  const json: unknown = await r.json().catch(() => null)
  return await runViewportProcess({
    geojson: json,
    maxVertices: opts.maxVertices,
    maxFeatures: opts.maxFeatures,
  })
}

export { parseFeatureCollection }
