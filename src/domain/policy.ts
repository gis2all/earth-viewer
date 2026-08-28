/**
 * 预算策略接口（W1.4）。
 * 零依赖纯类型 + 默认实现；默认值统一引用 domain/config.ts（W4.2 收敛后唯一来源）。
 */
import { DEFAULT_APP_CONFIG } from './config'

export interface BudgetPolicy {
  /** Feature / WFS：每层最大拉取/渲染要素数。 */
  maxFeatures: number
  /** 一个 webmap 内业务层合计要素预算，超出跳过后续层。 */
  maxTotalFeatures: number
  /** 单层渲染要素上限（超出取前 N 个降级）。 */
  maxRenderFeatures: number
  /** 单层几何顶点预算（超限先抽稀再截断）。 */
  maxRenderVertices: number
  /** GeoJSON / CSV / KML 文件载荷字节上限。 */
  maxFileBytes: number
  /** KML 更严格的字节上限（KmlDataSource 解析开销大）。 */
  kmlMaxBytes: number
  /** 矢量瓦片最大请求级别。 */
  vectorTileMaxZoom: number
  /** WMS / imagery provider 细节级别上限。 */
  imageryMaxLevel: number
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  maxFeatures: DEFAULT_APP_CONFIG.maxFeatures,
  maxTotalFeatures: DEFAULT_APP_CONFIG.maxTotalFeatures,
  maxRenderFeatures: DEFAULT_APP_CONFIG.maxRenderFeatures,
  maxRenderVertices: DEFAULT_APP_CONFIG.maxRenderVertices,
  maxFileBytes: DEFAULT_APP_CONFIG.maxFileBytes,
  kmlMaxBytes: DEFAULT_APP_CONFIG.kmlMaxBytes,
  vectorTileMaxZoom: DEFAULT_APP_CONFIG.vectorTileMaxZoom,
  imageryMaxLevel: DEFAULT_APP_CONFIG.imageryMaxLevel,
}

export function createBudgetPolicy(overrides?: Partial<BudgetPolicy>): BudgetPolicy {
  return overrides ? { ...DEFAULT_BUDGET_POLICY, ...overrides } : DEFAULT_BUDGET_POLICY
}
