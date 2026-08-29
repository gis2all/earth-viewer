import type { LayerKind, RiskLevel } from './types'
import type { LayerRuntime } from './layerRuntime'

/** 图层源输入：ArcGIS 搜索项或 webmap 内层（M1 后由 repository 统一产出）。 */
export interface LayerInput {
  id: string
  title?: string
  type?: string
  /** webmap 内层类型（部分 webmap 用 layerType 而非 type，结构上对齐 WebLayer 的常用字段）。 */
  layerType?: string
  url?: string
  /** 内嵌要素集等图层定义（FeatureCollection 判定需要）。 */
  layerDefinition?: Record<string, unknown>
  webmap?: Record<string, unknown>
}

/** 加载上下文：M1 后由 service 注入请求中间件与预算。 */
export interface LayerLoadContext {
  input: LayerInput
  signal: AbortSignal
  budget: { remaining: number }
}

/** 统一加载错误：失败一律抛此类型，便于 UI 映射提示。 */
export class LayerLoadError extends Error {
  constructor(
    public readonly code: 'aborted' | 'unsupported' | 'network' | 'budget',
    message: string
  ) {
    super(message)
    this.name = 'LayerLoadError'
  }
}

/**
 * 图层适配器契约：新增图层类型只需实现此接口并注册到 LAYER_REGISTRY（W1.2）。
 * 所有 adapter 必须通过 src/domain/layerAdapter.contract.test.ts 的契约测试。
 */
export interface LayerAdapter {
  readonly kind: LayerKind
  matches(input: LayerInput): boolean
  estimateRisk(input: LayerInput): RiskLevel
  load(ctx: LayerLoadContext): Promise<LayerRuntime>
}
