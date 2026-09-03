/**
 * WebLayer 的按类型渲染分发（globe 内）。
 *
 * 分发顺序严格对应旧 GlobeViewer/renderWebmap 分支：
 * imagery(试错可继续) → vector → featureCollection → scene → 3dTiles →
 * wfs → csv → feature → geojson → kml。
 * 除 imagery/vector/featureCollection 外，matches 同时要求 op.url，避免无服务地址的图层继续下抛。
 * 这里只保留一个静态有序分发表，不引入全局注册表。
 */
import type { FeatureStyleSpec, WebLayer } from '../domain/types'
import { DEFAULT_APP_CONFIG } from '../domain/config'
import { SAFETY, assertUrlWithinLimit } from '../domain/loadSafety'
import { runViewportProcess } from '../service/processing/viewportWorker'
import { queryViewportData } from './viewport/viewportQuery'
import { resolveFeatureQueryBase, resolveFeatureService } from './viewport/featureQuery'
import { createViewportDriver } from './viewport/viewportController'
import type { ViewEnvelope } from '../domain/geometry/geometry'
import { hasPrimitiveRendering } from '../infra/primitive'
import { fetchFeatureStyle, fetchFeatureRenderer } from '../infra/webmapProviders'
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
import { parseKmlToGeoJSON, kmlStyleToFeatureStyle, type KmlStyleSpec } from '../service/formats/kml'
import { fetchOgcFeatureGeoJSON } from '../service/formats/ogc'
import { fetchCsvGeoJSON } from '../service/formats/csv'
import type { LayerRenderJob } from '../domain/renderContract'
import type { CesiumFacade } from '../infra/cesiumFacade'

const VIEWPORT_FALLBACK: ViewEnvelope = DEFAULT_APP_CONFIG.viewportFallback
const EVENT_LAYER_MAX = DEFAULT_APP_CONFIG.eventLayerMax
const REF_LAYER_MAX = DEFAULT_APP_CONFIG.refLayerMax

type LayerRenderAction = 'handled' | 'continue' | 'stop'
type RenderDispatchResult = 'handled' | 'stop' | 'unhandled'

/** 渲染上下文：预算闭包与 keepAlive 由 renderWebmap 持有，渲染器只消费不管理。 */
interface WebLayerRenderContext {
  job: LayerRenderJob
  facade: CesiumFacade
  signal: AbortSignal
  keepAlive(): boolean
  /** 顶点/要素预算消费；返回 null 表示剩余预算不足，应整图停止。 */
  consumeBudget(gj: unknown): { data: unknown; capped: boolean } | null
}

interface LayerRenderer {
  matches(op: WebLayer): boolean
  render(ctx: WebLayerRenderContext, op: WebLayer): Promise<LayerRenderAction>
}

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
function referenceStyleFn(
  renderer?: Record<string, unknown> | null
): ((props?: Record<string, unknown>) => FeatureStyleSpec | undefined) {
  const base = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
  return (props?: Record<string, unknown>) => {
    const s = base(props)
    if (!s) return undefined
    return { ...s, fill: [0, 0, 0, 0] }
  }
}

/** 由 renderWebmap 调用的入口：把单个内层交给第一个匹配的渲染器。 */
export async function renderWebLayer(op: WebLayer, ctx: WebLayerRenderContext): Promise<RenderDispatchResult> {
  for (const renderer of WEB_LAYER_RENDERERS) {
    if (!renderer.matches(op)) continue
    const action = await renderer.render(ctx, op)
    if (action === 'handled') return 'handled'
    if (action === 'stop') return 'stop'
  }
  return 'unhandled'
}

const imageryRenderer: LayerRenderer = {
  matches: () => true,
  async render(ctx, op) {
    const added = await ctx.facade.addWebLayerImagery(op, ctx.job.runtime, ctx.signal, ctx.keepAlive)
    if (!ctx.keepAlive()) return 'stop'
    return added ? 'handled' : 'continue'
  },
}

const vectorTileRenderer: LayerRenderer = {
  matches: isVectorTileInput,
  async render(ctx, op) {
    ctx.facade.addVectorTile(op, ctx.signal, ctx.job.runtime, ctx.keepAlive, ctx.job.onError, ctx.job.onClearError)
    return 'handled'
  },
}

const featureCollectionRenderer: LayerRenderer = {
  matches: isFeatureCollectionInput,
  async render(ctx, op) {
    const { job, facade: f } = ctx
    const fc = (op.layerDefinition as { featureCollection?: unknown } | undefined)?.featureCollection
    const realFc = (fc as { featureCollection?: unknown } | undefined)?.featureCollection ?? fc
    if (!realFc) {
      job.onError('内嵌要素集为空')
      return 'handled'
    }
    try {
      const res = await runViewportProcess({
        geojson: realFc,
        maxVertices: SAFETY.MAX_RENDER_VERTICES,
        maxFeatures: SAFETY.MAX_RENDER_FEATURES,
      })
      if (!ctx.keepAlive()) return 'stop'
      if (res.capped) job.onNote('内嵌数据量大，已按顶点/要素预算降级')
      const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, ctx.keepAlive)
      if (!ctx.keepAlive() || !ds) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] 内嵌要素集加载失败', op.title || op.url, e)
      job.onError('内嵌要素集加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const sceneRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isSceneInput(op),
  async render(ctx, op) {
    const { job, facade: f } = ctx
    try {
      const prim = await f.addScene(op.url as string, job.runtime, ctx.keepAlive)
      if (!ctx.keepAlive() || !prim) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] 3D 场景加载失败', op.url, e)
      job.onError('3D 场景加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const tiles3dRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && is3dTilesInput(op),
  async render(ctx, op) {
    const { job, facade: f } = ctx
    try {
      const tileset = await f.add3dTiles(op.url as string, job.runtime, ctx.keepAlive)
      if (!ctx.keepAlive() || !tileset) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] 3D Tiles 加载失败', op.url, e)
      job.onError('3D Tiles 加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const wfsRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isWfsInput(op),
  async render(ctx, op) {
    const { job, facade: f, signal, consumeBudget } = ctx
    try {
      const gj = await fetchOgcFeatureGeoJSON(op.url as string, op, signal)
      if (!ctx.keepAlive()) return 'stop'
      const res = await runViewportProcess({
        geojson: gj,
        maxVertices: SAFETY.MAX_RENDER_VERTICES,
        maxFeatures: SAFETY.MAX_RENDER_FEATURES,
      })
      if (res.capped) job.onNote('数据量大，已按顶点/要素预算降级')
      const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
      if (!b) {
        job.onNote('数据总量过大，已省略部分图层')
        return 'stop'
      }
      if (b.capped) job.onNote('数据量大，仅显示部分要素')
      const ds = await f.addGeoJson(b.data, job.runtime, undefined, ctx.keepAlive)
      if (!ctx.keepAlive() || !ds) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] WFS/OGC 要素图层加载失败', op.url, e)
      job.onError('WFS/OGC 要素图层加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const csvRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isCsvInput(op),
  async render(ctx, op) {
    const { job, facade: f, signal, consumeBudget } = ctx
    try {
      const gj = await fetchCsvGeoJSON(op.url as string, op, signal)
      if (!ctx.keepAlive()) return 'stop'
      const res = await runViewportProcess({
        geojson: gj,
        maxVertices: SAFETY.MAX_RENDER_VERTICES,
        maxFeatures: SAFETY.MAX_RENDER_FEATURES,
      })
      if (res.capped) job.onNote('数据量大，已按顶点/要素预算降级')
      const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
      if (!b) {
        job.onNote('数据总量过大，已省略部分图层')
        return 'stop'
      }
      if (b.capped) job.onNote('数据量大，仅显示部分要素')
      const ds = await f.addGeoJson(b.data, job.runtime, undefined, ctx.keepAlive)
      if (!ctx.keepAlive() || !ds) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] CSV 图层加载失败', op.url, e)
      job.onError('CSV 图层加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const featureRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isFeatureInput(op),
  render: (ctx, op) => renderFeatureLayer(ctx, op),
}

const geojsonRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isGeoJsonInput(op),
  async render(ctx, op) {
    const { job, facade: f, signal } = ctx
    try {
      await assertUrlWithinLimit(op.url as string, SAFETY.MAX_FILE_BYTES)
    } catch (e) {
      console.error('[layer] GeoJSON 过大', op.url, e)
      job.onError('GeoJSON 文件过大，已限制加载')
      return 'handled'
    }
    try {
      const r = await fetch(op.url as string, { signal: withFetchTimeout(signal) })
      const json = await r.json().catch(() => null)
      if (!ctx.keepAlive()) return 'stop'
      const res = await runViewportProcess({ geojson: json })
      if (res.capped) job.onNote('文件数据量大，已按顶点预算降级显示')
      const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, ctx.keepAlive)
      if (!ctx.keepAlive() || !ds) return 'stop'
      job.onClearError()
    } catch (e) {
      console.error('[layer] GeoJSON 图层加载失败', op.url, e)
      job.onError('GeoJSON 图层加载失败：' + (op.title || op.url))
    }
    return 'handled'
  },
}

const kmlRenderer: LayerRenderer = {
  matches: (op) => Boolean(op.url) && isKmlInput(op),
  render: (ctx, op) => renderKmlLayer(ctx, op),
}

/** 静态有序分发表；数组顺序即分支优先级，不要随意换位。 */
const WEB_LAYER_RENDERERS: readonly LayerRenderer[] = [
  imageryRenderer,
  vectorTileRenderer,
  featureCollectionRenderer,
  sceneRenderer,
  tiles3dRenderer,
  wfsRenderer,
  csvRenderer,
  featureRenderer,
  geojsonRenderer,
  kmlRenderer,
]

/** Feature 服务（视口驱动）：解析全部可查询层，自动飞到数据范围，每层独立预算防卡死。 */
async function renderFeatureLayer(ctx: WebLayerRenderContext, op: WebLayer): Promise<LayerRenderAction> {
  const { job, facade: f, signal, keepAlive } = ctx
  const env0 = f.viewEnvelope() ?? VIEWPORT_FALLBACK
  try {
    const svc = await resolveFeatureService(op.url as string)
    if (!keepAlive()) return 'stop'
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
      if (!keepAlive()) return 'stop'
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
          return 'handled'
        } catch (e) {
          console.error('[layer] Primitive 渲染失败，回退 GeoJSON', op.url, e)
          const ds = await f.addGeoJson({ type: 'FeatureCollection', features: [] }, job.runtime, undefined, keepAlive)
          if (!keepAlive() || !ds) return 'stop'
          job.onClearError()
          return 'handled'
        }
      }
      const styleFn = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
      const res = await queryViewportData(base, env0, { maxFeatures: SAFETY.MAX_RENDER_FEATURES, outFields: '*' }, signal)
      if (!keepAlive()) return 'stop'
      if (res.capped) job.onNote('数据量大，已按视口/预算降级显示')
      const ds = await f.addGeoJson(
        { type: 'FeatureCollection', features: res.features },
        job.runtime,
        style ? { markerColor: style.markerColor, markerSize: style.markerSize, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill } : undefined,
        keepAlive
      )
      if (!keepAlive() || !ds) return 'stop'
      applyFeatureStyler(ds as never, styleFn)
      job.onClearError()
      return 'handled'
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
    if (!keepAlive()) return 'stop'
    job.onClearError()
  } catch (e) {
    console.error('[layer] Feature 图层加载失败', op.url, e)
    job.onError('要素图层加载失败：' + (op.title || op.url))
  }
  return 'handled'
}

/** KML → GeoJSON → 预算管线；解析不出要素时回退原生 KmlDataSource（保留图标/样式）。 */
async function renderKmlLayer(ctx: WebLayerRenderContext, op: WebLayer): Promise<LayerRenderAction> {
  const { job, facade: f } = ctx
  const kmlUrl = op.url as string
  try {
    await assertUrlWithinLimit(kmlUrl, SAFETY.KML_MAX_BYTES)
  } catch (e) {
    console.error('[layer] KML 过大', kmlUrl, e)
    job.onError('KML 文件过大，已限制加载')
    return 'handled'
  }
  const kmlStyleFn = (props?: Record<string, unknown>) =>
    kmlStyleToFeatureStyle((props?.kmlStyle ?? undefined) as KmlStyleSpec | undefined)
  try {
    const r = await fetch(kmlUrl, { signal: withFetchTimeout(ctx.signal) })
    const kmlText = await r.text()
    const gj = parseKmlToGeoJSON(kmlText)
    if (gj.features.length === 0) throw new Error('no features')
    const res = await runViewportProcess({
      geojson: gj,
      maxVertices: SAFETY.MAX_RENDER_VERTICES,
      maxFeatures: SAFETY.MAX_RENDER_FEATURES,
    })
    if (res.capped) job.onNote('KML 数据量大，已按顶点/要素预算降级显示')
    const ds = await f.addGeoJson({ type: 'FeatureCollection', features: res.features }, job.runtime, undefined, ctx.keepAlive)
    if (!ctx.keepAlive() || !ds) return 'stop'
    applyFeatureStyler(ds as never, kmlStyleFn)
    job.onClearError()
  } catch (e) {
    console.warn('[layer] KML 转 GeoJSON 失败，回退原生', kmlUrl, e)
    try {
      const ds = await f.addKmlNative(kmlUrl, job.runtime, ctx.keepAlive)
      if (!ctx.keepAlive() || !ds) return 'stop'
      job.onClearError()
    } catch (e2) {
      console.error('[layer] KML 图层加载失败', kmlUrl, e2)
      job.onError('KML 图层加载失败：' + (op.title || kmlUrl))
    }
  }
  return 'handled'
}
