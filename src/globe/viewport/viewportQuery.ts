import type { FeatureQueryOptions } from './featureQuery'
import type { ViewEnvelope } from '../../domain/geometry/envelope'
import { buildFeatureQueryUrl, parseFeatureCollection, resolveFeatureQueryBase } from './featureQuery'
import { runViewportProcess } from '../../service/processing/viewportWorker'
import type { ViewportProcessResult } from '../../service/processing/viewportProcess'
import { fetchJson } from '../../service/http'

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
  // 先解析可查询层（不硬编码 /0），再构建视口 query URL
  const base = await resolveFeatureQueryBase(serviceUrl)
  const url = buildFeatureQueryUrl(base, env, opts)
  const r = await fetchJson<Response>(url, { signal }, { throwHttpErrors: false })
  if (!r.ok) throw new Error('ArcGIS 视口查询失败')
  const json: unknown = await r.json().catch(() => null)
  return await runViewportProcess({
    geojson: json,
    maxVertices: opts.maxVertices,
    maxFeatures: opts.maxFeatures,
  })
}

export { parseFeatureCollection }
