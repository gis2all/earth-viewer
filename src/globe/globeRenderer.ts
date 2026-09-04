/**
 * renderWebmap（W3.5 核心）：把一个 webmap 的全部内层渲染到球上。
 * - 唯一 Cesium 接触面是 CesiumFacade（经依赖注入），本模块不直接 import Cesium；
 * - 内层按类型分发给 src/globe/webLayerRenderer.ts 的静态有序表，
 *   顺序即旧 GlobeViewer 分支顺序：imagery → vector → featureCollection →
 *   scene/3dtiles/wfs/csv/feature/geojson/kml；
 * - 本文件保留公共语义：相机优先、业务层上限、跨层预算/降级、错误提示与清错时机。
 */
import type { CesiumFacade } from '../infra/cesiumFacade'
import type { LayerRenderJob } from '../domain/renderContract'
import { renderableLayersFromWebmap, skippedBusinessLayers, MAX_BUSINESS_LAYERS } from '../domain/layerAssessment'
import { SAFETY, consumeFeatureBudget } from '../domain/loadSafety'
import { applyVertexBudget } from '../service/processing/viewportPipeline'
import { viewpointCameraFromWebmap } from '../infra/webmapCamera'
import type { ViewEnvelope } from '../domain/geometry/geometry'
import type { WebLayer } from '../domain/types'
import { classifyWebLayerKind } from '../domain/webLayerKind'
import { reprojectCoordinates } from '../infra/vector'
import { detectMapService, fetchServiceGeoExtent } from '../service/repository'
import { renderWebLayer } from './webLayerRenderer'

/** 独立 Map/Image 服务的 WGS84 范围。
 * 1. 探测返回的 fullExtent 若已是 4326 直接用；
 * 2. 否则用 proj4 把 native CRS 反投影到 4326（28992 已在 src/infra/vector 注册）；
 * 3. proj4 不认识的局部 CRS（如 102682）回退为服务端 query outSR=4326 求外包框。
 */
async function resolveServiceGeoExtent(layer: WebLayer, signal?: AbortSignal): Promise<ViewEnvelope | null> {
  const url = layer.url
  if (!url) return null
  const kind = classifyWebLayerKind(layer)
  if (kind !== 'map' && kind !== 'image') return null
  const crs = await detectMapService(url, signal)
  if (!crs?.extent) return null
  const e = crs.extent
  if (crs.wkid === 4326) {
    return [e.west, e.south, e.east, e.north].every(Number.isFinite) ? { west: e.west, south: e.south, east: e.east, north: e.north } : null
  }
  try {
    const [w, s] = reprojectCoordinates([e.west, e.south], 'EPSG:' + crs.wkid, 'EPSG:4326') as [number, number]
    const [ea, n] = reprojectCoordinates([e.east, e.north], 'EPSG:' + crs.wkid, 'EPSG:4326') as [number, number]
    if ([w, s, ea, n].every(Number.isFinite)) return { west: w, south: s, east: ea, north: n }
  } catch {
    // 未知投影，走服务端查询兜底
  }
  return fetchServiceGeoExtent(url, signal)
}

/** 独立服务 webmap（无初始相机视图、仅单个可渲染业务层）时，把相机飞到该层的数据范围。 */
async function serviceExtentForFlight(wm: Record<string, unknown>, signal?: AbortSignal): Promise<ViewEnvelope | null> {
  const layers = renderableLayersFromWebmap(wm)
  if (layers.length !== 1) return null
  const ext = await resolveServiceGeoExtent(layers[0], signal)
  // 全球级范围（覆盖近整个地球）不跳相机：保持用户当前视角，避免添加世界底图时被拉到全球总览
  if (ext && (ext.east - ext.west >= 300 || ext.north - ext.south >= 150)) return null
  return ext
}

/** 渲染一个 webmap 的全部内层；抛错由 LayerController 兜底为"图层加载失败"。 */
export async function renderWebmap(job: LayerRenderJob, f: CesiumFacade): Promise<void> {
  const wm = job.webmap
  const signal = job.signal
  const keepAlive = () => job.keepAlive()
  const skippedBusiness = skippedBusinessLayers(wm)
  if (skippedBusiness > 0) {
    job.onNote(`此地图含多个业务图层，仅渲染前 ${MAX_BUSINESS_LAYERS} 个（略过 ${skippedBusiness} 个）`)
  }
  // 预算/降级：业务层要素合计超预算则跳过；单层超 MAX_RENDER_FEATURES 则截断，防 OOM/阻塞
  const budget: { remaining: number } = { remaining: SAFETY.MAX_TOTAL_FEATURES }
  const consumeBudget = (gj: unknown): { data: unknown; capped: boolean } | null => {
    // ① 顶点预算：先抽稀再截断（防单个大 polygon 内存爆炸）
    const raw = gj as { type?: string; features?: Record<string, unknown>[] } | null
    const features = Array.isArray(raw?.features) ? raw.features : []
    const vb = applyVertexBudget({ type: 'FeatureCollection', features }, SAFETY.MAX_RENDER_VERTICES)
    // ② 要素数预算：再限制对象个数
    const r = consumeFeatureBudget(budget.remaining, vb.data, SAFETY.MAX_RENDER_FEATURES)
    if (!r) return null
    budget.remaining = r.remaining
    return { data: r.data, capped: vb.capped || r.capped }
  }

  // 相机优先：Web Map/Scene 自带初始相机 → 飞相机；否则回退到"程序初始位置"
  if (!job.hasFlew()) {
    job.markFlew()
    const cam = viewpointCameraFromWebmap(wm)
    if (cam) {
      try {
        f.flyTo(cam)
      } catch {
        // ignore
      }
    } else {
      // 独立服务：飞到服务数据范围，否则程序初始位置（世界视图）下局部图层不可见
      const ext = await serviceExtentForFlight(wm, signal)
      if (ext) {
        try {
          f.flyToExtent(ext)
        } catch {
          // ignore
        }
      } else {
        f.flyToHome()
      }
    }
  }

  for (const op of renderableLayersFromWebmap(wm)) {
    if (op.visibility === false) continue
    const result = await renderWebLayer(op, {
      job,
      facade: f,
      signal,
      keepAlive,
      consumeBudget,
    })
    if (result === 'stop') return
  }
}
