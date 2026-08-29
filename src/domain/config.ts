/**
 * 应用级配置（W4.2 常量收敛）。
 * - 零依赖纯类型 + 默认值，是全部领域/渲染/相机/UI 常量的唯一来源；
 * - configureApp() 在运行时整体/局部覆盖（如注入 window 配置、E2E 覆盖）；
 *   appConfig() 返回当前生效配置；resetAppConfig() 恢复默认（测试用）；
 * - 注意：模块加载时已读取的值不会自动刷新；覆盖需在相关模块初始化前完成；
 * - 主题 token 不在此处（归 DESIGN.md）。
 */

/** 视口范围（结构上兼容 globe/viewport/featureQuery 的 ViewEnvelope）。 */
export interface ViewEnvelopeConfig {
  west: number
  south: number
  east: number
  north: number
}

/** 相机交互/缩放默认值（原 CameraController 内部常量，deps 仍可覆盖）。 */
export interface CameraConfig {
  /** 相机高度下限（米）。 */
  minZoom: number
  /** 相机高度上限（米）。 */
  maxZoom: number
  /** 俯仰角下限（弧度，接近垂直向下）。 */
  minPitch: number
  /** 俯仰角上限（弧度，地平线）。 */
  maxPitch: number
  /** 滚轮缩小速度系数。 */
  wheelOutFactor: number
  /** 滚轮放大速度系数。 */
  wheelInFactor: number
  /** 静止多久后开始自动环绕（毫秒）。 */
  autoRotateIdleMs: number
  /** 自动环绕每帧步进（弧度）。 */
  autoRotateStepRad: number
  /** 回正缓动系数。 */
  zoomEase: number
  /** 交互中的分辨率缩放（SSE 上限）。 */
  sseZooming: number
  /** 静止后的分辨率缩放（SSE 上限）。 */
  sseSettled: number
  /** 双击缩放比例。 */
  doubleClickZoomRatio: number
  /** 滚轮交互生效窗口（毫秒，防止惯性误触发环绕）。 */
  wheelActiveWindowMs: number
}

/** 侧边面板 UI 常量（原 LayerPanel 局部常量）。 */
export interface PanelConfig {
  /** 搜索结果首页条数。 */
  galleryPage: number
  /** “加载更多”每次追加条数。 */
  appendStep: number
  /** 默认封面路径（相对 BASE_URL，组件内拼完整地址）。 */
  defaultCover: string
  /** 缩略图加载超时（毫秒），超时回退默认封面。 */
  thumbTimeoutMs: number
}

/** 应用全部可配置常量。 */
export interface AppConfig {
  // ---- 预算（domain/loadSafety.ts SAFETY 的唯一数据来源）----
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

  // ---- 视口 ----
  /** 无 fullExtent 时的兜底世界范围。 */
  viewportFallback: ViewEnvelopeConfig

  // ---- 渲染 ----
  /** 事件层要素上限（超过则抽稀）。 */
  eventLayerMax: number
  /** 参考/辅助层要素上限。 */
  refLayerMax: number
  /** 一个 webmap 内最多渲染的业务层数。 */
  maxBusinessLayers: number

  // ---- 相机 ----
  camera: CameraConfig

  // ---- UI 面板 ----
  panel: PanelConfig
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  maxFeatures: 3000,
  maxTotalFeatures: 5000,
  maxRenderFeatures: 1500,
  maxRenderVertices: 200_000,
  maxFileBytes: 8_000_000,
  kmlMaxBytes: 2_000_000,
  vectorTileMaxZoom: 16,
  imageryMaxLevel: 16,

  viewportFallback: { west: -180, south: -90, east: 180, north: 90 },

  eventLayerMax: 800,
  refLayerMax: 150,
  maxBusinessLayers: 5,

  camera: {
    minZoom: 20,
    maxZoom: 25_000_000,
    minPitch: (-89.9 * Math.PI) / 180,
    maxPitch: 0,
    wheelOutFactor: 1.25,
    wheelInFactor: 0.8,
    autoRotateIdleMs: 3000,
    autoRotateStepRad: 0.0012,
    zoomEase: 0.25,
    sseZooming: 2,
    sseSettled: 1,
    doubleClickZoomRatio: 0.5,
    wheelActiveWindowMs: 1500,
  },

  panel: {
    galleryPage: 24,
    appendStep: 12,
    defaultCover: 'covers/default.png',
    thumbTimeoutMs: 60000,
  },
}

let current: AppConfig = DEFAULT_APP_CONFIG

export function configureApp(overrides: Partial<AppConfig>): AppConfig {
  current = {
    ...current,
    ...overrides,
    viewportFallback: overrides.viewportFallback ?? current.viewportFallback,
    camera: { ...current.camera, ...overrides.camera },
    panel: { ...current.panel, ...overrides.panel },
  }
  return current
}

export function appConfig(): AppConfig {
  return current
}

export function resetAppConfig(): void {
  current = DEFAULT_APP_CONFIG
}
