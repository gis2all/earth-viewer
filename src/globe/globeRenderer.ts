/**
 * renderWebmap（W3.5 核心）：把一个 webmap 的全部内层渲染到球上。
 * - 唯一 Cesium 接触面是 CesiumFacade（经依赖注入），本模块不直接 import Cesium；
 * - 保留 GlobeViewer.renderOperationalLayers 的全部业务行为：相机优先、预算/降级、
 *   分支顺序（影像 → 矢量瓦片 → 内嵌要素集 → scene/3dtiles/wfs/csv/feature/geojson/kml）、
 *   错误提示与清错时机；
 * - 数据获取/转换仍走 globe 既有模块（webmap/viewport/kml/ogc/csv），由 LayerController 串行调度。
 */
import type { CesiumFacade } from '../infra/cesiumFacade'
import type { LayerRenderJob } from '../domain/renderContract'
import { DEFAULT_APP_CONFIG } from '../domain/config'
import { renderableLayersFromWebmap, skippedBusinessLayers, MAX_BUSINESS_LAYERS } from '../domain/layerAssessment'
import { SAFETY, assertUrlWithinLimit, consumeFeatureBudget } from '../domain/loadSafety'
import { applyVertexBudget } from '../service/processing/viewportPipeline'
import { queryViewportData } from './viewport/viewportQuery'
import { resolveFeatureQueryBase, resolveFeatureService } from './viewport/featureQuery'
import { createViewportDriver } from './viewport/viewportController'
import type { ViewEnvelope } from '../domain/geometry/geometry'
import { runViewportProcess } from '../service/processing/viewportWorker'
import { hasPrimitiveRendering } from '../infra/primitive'
import {
  fetchFeatureStyle,
  fetchFeatureRenderer,
} from '../infra/webmapProviders'
import { withFetchTimeout } from '../service/http'
import {
  isVectorTileInput,
  isFeatureCollectionInput,
  isSceneInput,
  is3dTilesInput,
  isWfsInput,
  isCsvInput,
  isFeatureInput,
  isGeoJsonInput,
  isKmlInput,
} from '../domain/layerRegistry'
import { rendererToStyleFn, applyFeatureStyler, reprojectCoordinates } from '../infra/vector'
import type { FeatureStyleSpec } from '../domain/types'
import { parseKmlToGeoJSON, kmlStyleToFeatureStyle, type KmlStyleSpec } from '../service/formats/kml'
import { fetchOgcFeatureGeoJSON } from '../service/formats/ogc'
import { fetchCsvGeoJSON } from '../service/formats/csv'
import { viewpointCameraFromWebmap } from '../infra/webmapCamera'

const VIEWPORT_FALLBACK: ViewEnvelope = DEFAULT_APP_CONFIG.viewportFallback

const EVENT_LAYER_MAX = DEFAULT_APP_CONFIG.eventLayerMax
const REF_LAYER_MAX = DEFAULT_APP_CONFIG.refLayerMax

/** 将服务 fullExtent 重投影到 4326（失败保留原范围）。 */
function reprojectExtent(e: { west: number; south: number; east: number; north: number; wkid: number }) {
  if (e.wkid === 4326 || e.wkid === 4269) return e
  try {
    const [w, s] = reprojectCoordinates([e.west, e.south], 'EPSG:' + e.wkid, 'EPSG:4326') as [number, number]
    const [ea, n] = reprojectCoordinates([e.east, e.north], 'EPSG:' + e.wkid, 'EPSG:4326') as [number, number]
    if ([w, s, ea, n].every(Number.isFinite)) return { west: w, south: s, east: ea, north: n, wkid: 4326 }
  } catch {
    /* 重投影失败保留原范围 */
  }
  return e
}

function envContainsForFlight(env: ViewEnvelope, ext: ViewEnvelope): boolean {
  return !(env.east < ext.west || env.west > ext.east || env.north < ext.south || env.south > ext.north)
}

/** 区划/参考层风格：只描边，透明填充，避免盖住事件层。 */
function referenceStyleFn(renderer?: Record<string, unknown> | null): ((props?: Record<string, unknown>) => FeatureStyleSpec | undefined) {
  const base = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
  return (props?: Record<string, unknown>) => {
    const s = base(props)
    if (!s) return undefined
    return { ...s, fill: [0, 0, 0, 0] }
  }
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
      f.flyToHome()
    }
  }

  for (const op of renderableLayersFromWebmap(wm)) {
    if (op.visibility === false) continue
    const addedImagery = await f.addWebLayerImagery(op, job.runtime, signal, keepAlive)
    if (!keepAlive()) return
    if (addedImagery) continue

    if (isVectorTileInput(op)) {
      // 方案 A：MapLibre GL 按 ArcGIS 官方样式渲染矢量瓦片 → Cesium ImageryProvider
      f.addVectorTile(op, signal, job.runtime, keepAlive, job.onError, job.onClearError)
    } else if (isFeatureCollectionInput(op)) {
      // 内嵌 FeatureCollection（layerDefinition.featureCollection）：走 Worker 预算管线，防大内嵌数据集卡死
      const fc = (op.layerDefinition as { featureCollection?: unknown } | undefined)?.featureCollection
      const realFc = (fc as { featureCollection?: unknown } | undefined)?.featureCollection ?? fc
      if (!realFc) {
        job.onError('内嵌要素集为空')
        continue
      }
      try {
        const res = await runViewportProcess({
          geojson: realFc,
          maxVertices: SAFETY.MAX_RENDER_VERTICES,
          maxFeatures: SAFETY.MAX_RENDER_FEATURES,
        })
        if (!keepAlive()) return
        if (res.capped) job.onNote('内嵌数据量大，已按顶点/要素预算降级')
        const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, keepAlive)
        if (!keepAlive() || !ds) return
        job.onClearError()
      } catch (e) {
        console.error('[layer] 内嵌要素集加载失败', op.title || op.url, e)
        job.onError('内嵌要素集加载失败：' + (op.title || op.url))
      }
    } else if (op.url) {
      if (isSceneInput(op)) {
        // ArcGIS SceneServer / I3S 3D 场景
        try {
          const prim = await f.addScene(op.url, job.runtime, keepAlive)
          if (!keepAlive() || !prim) return
          job.onClearError()
        } catch (e) {
          console.error('[layer] 3D 场景加载失败', op.url, e)
          job.onError('3D 场景加载失败：' + (op.title || op.url))
        }
      } else if (is3dTilesInput(op)) {
        // OGC 3D Tiles
        try {
          const tileset = await f.add3dTiles(op.url, job.runtime, keepAlive)
          if (!keepAlive() || !tileset) return
          job.onClearError()
        } catch (e) {
          console.error('[layer] 3D Tiles 加载失败', op.url, e)
          job.onError('3D Tiles 加载失败：' + (op.title || op.url))
        }
      } else if (isWfsInput(op)) {
        // WFS / OGC API Features：通过协议适配器读取 GeoJSON
        try {
          const gj = await fetchOgcFeatureGeoJSON(op.url, op, signal)
          if (!keepAlive()) return
          const res = await runViewportProcess({
            geojson: gj,
            maxVertices: SAFETY.MAX_RENDER_VERTICES,
            maxFeatures: SAFETY.MAX_RENDER_FEATURES,
          })
          if (res.capped) job.onNote('数据量大，已按顶点/要素预算降级')
          const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
          if (!b) {
            job.onNote('数据总量过大，已省略部分图层')
            return
          }
          if (b.capped) job.onNote('数据量大，仅显示部分要素')
          const ds = await f.addGeoJson(b.data, job.runtime, undefined, keepAlive)
          if (!keepAlive() || !ds) return
          job.onClearError()
        } catch (e) {
          console.error('[layer] WFS/OGC 要素图层加载失败', op.url, e)
          job.onError('WFS/OGC 要素图层加载失败：' + (op.title || op.url))
        }
      } else if (isCsvInput(op)) {
        // CSV：按位置字段转换为点 GeoJSON
        try {
          const gj = await fetchCsvGeoJSON(op.url, op, signal)
          if (!keepAlive()) return
          const res = await runViewportProcess({
            geojson: gj,
            maxVertices: SAFETY.MAX_RENDER_VERTICES,
            maxFeatures: SAFETY.MAX_RENDER_FEATURES,
          })
          if (res.capped) job.onNote('数据量大，已按顶点/要素预算降级')
          const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
          if (!b) {
            job.onNote('数据总量过大，已省略部分图层')
            return
          }
          if (b.capped) job.onNote('数据量大，仅显示部分要素')
          const ds = await f.addGeoJson(b.data, job.runtime, undefined, keepAlive)
          if (!keepAlive() || !ds) return
          job.onClearError()
        } catch (e) {
          console.error('[layer] CSV 图层加载失败', op.url, e)
          job.onError('CSV 图层加载失败：' + (op.title || op.url))
        }
      } else if (isFeatureInput(op)) {
        await renderFeatureLayer(job, f, op, signal, keepAlive)
      } else if (isGeoJsonInput(op)) {
        // GeoJSON 文件：URL 体积守卫 + fetch + 预算管线
        try {
          await assertUrlWithinLimit(op.url, SAFETY.MAX_FILE_BYTES)
        } catch (e) {
          console.error('[layer] GeoJSON 过大', op.url, e)
          job.onError('GeoJSON 文件过大，已限制加载')
          continue
        }
        try {
          const r = await fetch(op.url, { signal: withFetchTimeout(signal) })
          const json = await r.json().catch(() => null)
          if (!keepAlive()) return
          const res = await runViewportProcess({ geojson: json })
          if (res.capped) job.onNote('文件数据量大，已按顶点预算降级显示')
          const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, keepAlive)
          if (!keepAlive() || !ds) return
          job.onClearError()
        } catch (e) {
          console.error('[layer] GeoJSON 图层加载失败', op.url, e)
          job.onError('GeoJSON 图层加载失败：' + (op.title || op.url))
        }
      } else if (isKmlInput(op)) {
        await renderKmlLayer(job, f, op, signal, keepAlive)
      }
    }
  }
}

/** Feature 服务（视口驱动）：解析全部可查询层，自动飞到数据范围，每层独立预算防卡死。 */
async function renderFeatureLayer(
  job: LayerRenderJob,
  f: CesiumFacade,
  op: { url?: string; title?: string },
  signal: AbortSignal,
  keepAlive: () => boolean
): Promise<void> {
  const env0 = f.viewEnvelope() ?? VIEWPORT_FALLBACK
  try {
    const svc = await resolveFeatureService(op.url as string)
    if (!keepAlive()) return
    const ext = svc.extent ? reprojectExtent(svc.extent) : undefined
    if (ext && !envContainsForFlight(env0, ext)) {
      try {
        f.flyToExtent(ext)
      } catch {
        // 飞行失败忽略
      }
    }
    const layerBases = svc.layers
    if (layerBases.length <= 1) {
      const base = layerBases[0] ?? (op.url as string)
      const [style, renderer] = await Promise.all([fetchFeatureStyle(base), fetchFeatureRenderer(base)])
      if (!keepAlive()) return
      const rendererType = String((renderer as Record<string, unknown> | null)?.type ?? '')
      const hasRendererStyle = !!renderer && ['simple', 'uniqueValue', 'classBreaks'].includes(rendererType)
      if (hasPrimitiveRendering() && !hasRendererStyle) {
        try {
          const base2 = await resolveFeatureQueryBase(op.url as string)
          const surface = f.viewportSurface()
          if (surface) {
            const handle = createViewportDriver(surface, {
              serviceUrl: base2,
              maxFeatures: SAFETY.MAX_FEATURES,
            })
            job.attachViewport?.(handle)
          }
          job.onClearError()
          return
        } catch (e) {
          console.error('[layer] Primitive 渲染失败，回退 GeoJSON', op.url, e)
          const ds = await f.addGeoJson({ type: 'FeatureCollection', features: [] }, job.runtime, undefined, keepAlive)
          if (!keepAlive() || !ds) return
          job.onClearError()
          return
        }
      }
      const styleFn = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
      const res = await queryViewportData(base, env0, { maxFeatures: SAFETY.MAX_RENDER_FEATURES, outFields: '*' }, signal)
      if (!keepAlive()) return
      if (res.capped) job.onNote('数据量大，已按视口/预算降级显示')
      const ds = await f.addGeoJson(
        { type: 'FeatureCollection', features: res.features },
        job.runtime,
        style ? { markerColor: style.markerColor, markerSize: style.markerSize, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill } : undefined,
        keepAlive
      )
      if (!keepAlive() || !ds) return
      applyFeatureStyler(ds as never, styleFn)
      job.onClearError()
      return
    }
    // 分层：区划层(simple)仅描边参考，事件层(unique/classBreaks)填充分色，每层独立预算不互相挤占
    const makeLayer = async (base: string) => {
      const [style, renderer] = await Promise.all([fetchFeatureStyle(base), fetchFeatureRenderer(base)])
      if (!keepAlive()) return null
      const rt = String((renderer as Record<string, unknown> | null)?.type ?? '')
      const isRef = rt === 'simple'
      // 区划/参考层（simple）可用开关控制：关闭时不渲染，开启时用低预算描边
      if (isRef && !job.isReferenceVisible()) return null
      const maxFeatures = isRef ? REF_LAYER_MAX : EVENT_LAYER_MAX
      const styleFn = isRef ? referenceStyleFn(renderer) : rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
      const res = await queryViewportData(base, env0, { maxFeatures, outFields: '*' }, signal)
      if (!keepAlive()) return null
      if (res.capped) job.onNote('数据量大，已按视口/预算降级显示')
      if (res.features.length === 0) return null
      const ds = await f.addGeoJson(
        { type: 'FeatureCollection', features: res.features },
        job.runtime,
        style ? { markerColor: style.markerColor, markerSize: style.markerSize, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill } : undefined,
        keepAlive
      )
      if (!keepAlive() || !ds) return null
      applyFeatureStyler(ds as never, styleFn)
      return ds
    }
    await Promise.all(layerBases.map(makeLayer))
    if (!keepAlive()) return
    job.onClearError()
  } catch (e) {
    console.error('[layer] Feature 图层加载失败', op.url, e)
    job.onError('要素图层加载失败：' + (op.title || op.url))
  }
}

/** KML → GeoJSON → 预算管线；解析不出要素时回退原生 KmlDataSource（保留图标/样式）。 */
async function renderKmlLayer(
  job: LayerRenderJob,
  f: CesiumFacade,
  op: { url?: string; title?: string },
  signal: AbortSignal,
  keepAlive: () => boolean
): Promise<void> {
  const kmlUrl = op.url as string
  try {
    await assertUrlWithinLimit(kmlUrl, SAFETY.KML_MAX_BYTES)
  } catch (e) {
    console.error('[layer] KML 过大', kmlUrl, e)
    job.onError('KML 文件过大，已限制加载')
    return
  }
  const kmlStyleFn = (props?: Record<string, unknown>) => kmlStyleToFeatureStyle((props?.kmlStyle ?? undefined) as KmlStyleSpec | undefined)
  try {
    const r = await fetch(kmlUrl, { signal: withFetchTimeout(signal) })
    const kmlText = await r.text()
    const gj = parseKmlToGeoJSON(kmlText)
    if (gj.features.length === 0) throw new Error('no features')
    const res = await runViewportProcess({
      geojson: gj,
      maxVertices: SAFETY.MAX_RENDER_VERTICES,
      maxFeatures: SAFETY.MAX_RENDER_FEATURES,
    })
    if (res.capped) job.onNote('KML 数据量大，已按顶点/要素预算降级显示')
    const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, keepAlive)
    if (!keepAlive() || !ds) return
    applyFeatureStyler(ds as never, kmlStyleFn)
    job.onClearError()
  } catch (e) {
    console.warn('[layer] KML 转 GeoJSON 失败，回退原生', kmlUrl, e)
    try {
      const ds = await f.addKmlNative(kmlUrl, job.runtime, keepAlive)
      if (!keepAlive() || !ds) return
      job.onClearError()
    } catch (e2) {
      console.error('[layer] KML 图层加载失败', kmlUrl, e2)
      job.onError('KML 图层加载失败：' + (op.title || kmlUrl))
    }
  }
}
