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
import { renderWebLayer } from './webLayerRenderer'

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
