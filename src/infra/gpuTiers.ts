/**
 * GPU 内存预算档位（B 档：完整动态预算管理器）。
 *
 * 全局统一由 GpuMemoryManager 决定当前档位，矢量瓦片 provider 按档位调整
 * 离屏画布尺寸 / 并发实例数 / 块缓存上限，CesiumFacade 按档位调整主场景
 * resolutionScale。档位只降不升（除非显式重建），优先保证程序不因 GPU
 * 内存耗尽而崩溃。
 */

export type GpuTierName = 'high' | 'medium' | 'low' | 'critical'

export interface GpuTierConfig {
  name: GpuTierName
  /** MapLibre 离屏画布边长（CSS px；3x3 块 @512px 瓦片 = 1536） */
  canvasSize: number
  /** 每块瓦片数（3 → 3x3；与画布边长联动） */
  blockSize: number
  /** 并行 MapLibre 实例上限 */
  poolSize: number
  /** 3D 块 LRU 缓存上限 */
  cacheBlocks: number
  /** Cesium scene.resolutionScale（<1 时降低主场景渲染分辨率） */
  resolutionScale: number
  /** 相机静止时暂停离屏渲染（仅相机移动时才出图，极限档） */
  offscreenPaused: boolean
}

export const GPU_TIERS: Record<GpuTierName, GpuTierConfig> = {
  high: {
    name: 'high',
    canvasSize: 1536,
    blockSize: 3,
    poolSize: 3,
    cacheBlocks: 12,
    resolutionScale: 1,
    offscreenPaused: false,
  },
  medium: {
    name: 'medium',
    canvasSize: 1024,
    blockSize: 2,
    poolSize: 2,
    cacheBlocks: 8,
    resolutionScale: 1,
    offscreenPaused: false,
  },
  low: {
    name: 'low',
    canvasSize: 512,
    blockSize: 1,
    poolSize: 2,
    cacheBlocks: 6,
    resolutionScale: 0.75,
    offscreenPaused: false,
  },
  critical: {
    name: 'critical',
    canvasSize: 512,
    blockSize: 1,
    poolSize: 1,
    cacheBlocks: 4,
    resolutionScale: 0.5,
    offscreenPaused: true,
  },
}

export const GPU_TIER_ORDER: GpuTierName[] = ['high', 'medium', 'low', 'critical']

/** 按档位估算单个矢量瓦片 provider 的像素内存（WebGL 画布 + 块缓存），单位字节。 */
export function estimateVectorProviderBytes(tier: GpuTierConfig, tileSize = 512): number {
  const glBytes = tier.poolSize * tier.canvasSize ** 2 * 4 * 2
  const cacheBytes = tier.cacheBlocks * tier.blockSize ** 2 * tileSize ** 2 * 4
  return glBytes + cacheBytes
}

/** 按档位估算主场景渲染缓冲（画布 RGBA ×2 双缓冲 × resolutionScale²），单位字节。 */
export function estimateSceneCanvasBytes(
  width: number,
  height: number,
  tier: GpuTierConfig
): number {
  return width * height * 4 * 2 * tier.resolutionScale ** 2
}
