/**
 * 统一图层运行时：M1 后替代 GlobeViewer 内联的 layerMapRef 巨型条目类型。
 * 不引用任何渲染库，由 infra（CesiumFacade）负责把运行时落到具体渲染对象。
 */
export interface LayerImagery {
  readonly id: string
  alpha: number
  dispose(): void
}

export interface LayerDataSource {
  readonly id: string
  dispose(): void
}

export interface LayerPrimitive {
  readonly id: string
  dispose(): void
}

export interface LayerVectorProvider {
  readonly id: string
  destroy(): void
}

export interface LayerRuntime {
  imagery: LayerImagery[]
  dataSources: LayerDataSource[]
  primitives: LayerPrimitive[]
  vectorProviders: LayerVectorProvider[]
  /** 一次性释放全部资源；必须幂等（可重复调用）。 */
  dispose(): void
}

/** 构造空运行时（真实 adapter 无资源可挂载时使用）。 */
export function createEmptyRuntime(): LayerRuntime {
  return {
    imagery: [],
    dataSources: [],
    primitives: [],
    vectorProviders: [],
    dispose: () => {},
  }
}
