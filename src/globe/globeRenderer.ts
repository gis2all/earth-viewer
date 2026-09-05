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
import { detectMapService, fetchSceneExtent, fetchServiceGeoExtent } from '../service/repository'
import { renderWebLayer } from './webLayerRenderer'
import { appConfig } from '../domain/config'

/** 独立 Map/Image 服务的 WGS84 范围。
 * 1. 探测返回的 fullExtent 若已是 4326 直接用；
 * 2. 否则用 proj4 把 native CRS 反投影到 4326（28992 已在 src/infra/vector 注册）；
 * 3. proj4 不认识的局部 CRS（如 102682）回退为服务端 query outSR=4326 求外包框。
 */
async function resolveServiceGeoExtent(layer: WebLayer, signal?: AbortSignal): Promise<ViewEnvelope | null> {
  const url = layer.url
  if (!url) return null
  const kind = classifyWebLayerKind(layer)
  if (kind !== 'map' && kind !== 'image' && kind !== 'scene') return null
  if (kind === 'scene') {
    // I3S 场景：外层无 fullExtent，读 SceneLayer 的 fullExtent 反投影；未知投影则放弃飞行
    const native = await fetchSceneExtent(url, signal)
    if (!native) return null
    try {
      if (native.wkid === 4326) return { west: native.west, south: native.south, east: native.east, north: native.north }
      const [w, s] = reprojectCoordinates([native.west, native.south], 'EPSG:' + native.wkid, 'EPSG:4326') as [number, number]
      const [ea, n] = reprojectCoordinates([native.east, native.north], 'EPSG:' + native.wkid, 'EPSG:4326') as [number, number]
      if ([w, s, ea, n].every(Number.isFinite)) return { west: w, south: s, east: ea, north: n }
    } catch {
      return null
    }
    return null
  }
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
async function serviceExtentForFlight(
  wm: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ ext: ViewEnvelope | null; isScene: boolean }> {
  const layers = renderableLayersFromWebmap(wm)
  if (layers.length !== 1) return { ext: null, isScene: false }
  const layer = layers[0]
  const ext = await resolveServiceGeoExtent(layer, signal)
  return { ext, isScene: classifyWebLayerKind(layer) === 'scene' }
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
      const maxZoom = appConfig().camera.maxZoom
      // Web Map/Scene 自带相机高度超出交互上限时飞不到可拖拽的球面，回退到复位高度保持一致
      if (typeof cam.heightMeters === 'number' && cam.heightMeters > maxZoom) {
        f.flyToHome()
      } else {
        try {
          f.flyTo(cam)
        } catch {
          // ignore
        }
      }
    } else {
      // 独立服务：飞到服务数据范围，否则程序初始位置（世界视图）下局部图层不可见
      const r = await serviceExtentForFlight(wm, signal)
      const isGlobal = !!r.ext && (r.ext.east - r.ext.west >= 300 || r.ext.north - r.ext.south >= 150)
      if (r.ext && !isGlobal) {
        try {
          f.flyToExtent(r.ext)
        } catch {
          // ignore
        }
      } else {
        f.flyToHome()
        // 全球级 3D 场景没有可定位中心：提示放大到城市，避免用户以为没渲染
        if (r.isScene && isGlobal) job.onNote?.('该 3D 场景覆盖全球，放大到城市可见对象')
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
