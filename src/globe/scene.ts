import * as Cesium from 'cesium'

/** 加载 ArcGIS SceneServer / I3S 场景层为 Cesium 数据提供器（挂到 scene.primitives） */
export async function loadI3S(url: string): Promise<unknown> {
  return Cesium.I3SDataProvider.fromUrl(url, {
    applySymbology: true,
    cesium3dTilesetOptions: {
      maximumScreenSpaceError: 16,
      // 限制背靠 3D Tiles 缓存内存，视域外自动卸载，防大场景撑爆
      cacheBytes: 128 * 1024 * 1024,
      maximumCacheOverflowBytes: 32 * 1024 * 1024,
    },
  })
}

/** 加载 OGC 3D Tiles 数据集（tileset.json） */
export async function load3DTiles(url: string, options?: { maximumScreenSpaceError?: number }): Promise<unknown> {
  return Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 16, cacheBytes: 128 * 1024 * 1024, maximumCacheOverflowBytes: 32 * 1024 * 1024, ...(options ?? {}) })
}
