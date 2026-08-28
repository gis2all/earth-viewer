/**
 * 预算策略接口（W1.4）。
 * 零依赖纯类型 + 默认实现；默认值镜像 globe/loadSafety.ts 的 SAFETY 常量
 * （SAFETY 仍是运行时默认值来源，W4.2 常量收敛时统一到 domain/config.ts）。
 */

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
  /** Scene / 3D Tiles LOD 上限。 */
  sceneMaxLod: number
  /** WMS / imagery provider 细节级别上限。 */
  imageryMaxLevel: number
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  maxFeatures: 3000,
  maxTotalFeatures: 5000,
  maxRenderFeatures: 1500,
  maxRenderVertices: 200_000,
  maxFileBytes: 8_000_000,
  kmlMaxBytes: 2_000_000,
  vectorTileMaxZoom: 16,
  sceneMaxLod: 15,
  imageryMaxLevel: 16,
}

export function createBudgetPolicy(overrides?: Partial<BudgetPolicy>): BudgetPolicy {
  return overrides ? { ...DEFAULT_BUDGET_POLICY, ...overrides } : DEFAULT_BUDGET_POLICY
}
