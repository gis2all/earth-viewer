/**
 * Controller → 渲染器 的契约类型（W3.1/W3.5）。
 * 纯 TS 类型，零依赖：LayerController 只认识这些接缝，
 * 具体 webmap 渲染由 globe/infra 实现（renderWebmap + CesiumFacade）。
 */
import type { LayerRuntime } from './runtime'

/** 视口驱动句柄（infra 实现）；删除图层时统一释放。 */
export interface ViewportHandleLike {
  unsubscribeMoveEnd(): void
  controller: { dispose(): void }
}

/** 渲染一个 webmap 全部内层所需的上下文。 */
export interface LayerRenderJob {
  id: string
  title: string
  webmap: Record<string, unknown>
  /** 该图层的统一运行时表：渲染器把 Cesium 资源挂进来，删除时由控制器释放。 */
  runtime: LayerRuntime
  signal: AbortSignal
  /** 图层是否仍存活（已删除/已卸载则返回 false，异步回调据此丢弃资源）。 */
  keepAlive(): boolean
  /** 标记"已处理过初始相机"（一个 webmap 只飞一次相机）。 */
  markFlew(): void
  /** 是否已处理过初始相机（渲染器在渲染开始时读取）。 */
  hasFlew(): boolean
  /** 区划/参考层是否可见（受效果开关控制）。 */
  isReferenceVisible(): boolean
  onNote(msg: string): void
  onError(msg: string): void
  onClearError(): void
  /** Feature 服务走视口驱动时挂载句柄，删除时由控制器清理。 */
  attachViewport?(handle: ViewportHandleLike): void
}
