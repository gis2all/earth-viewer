import * as Cesium from 'cesium'

/** 加载 ArcGIS SceneServer / I3S 场景层为 Cesium 数据提供器（挂到 scene.primitives） */
export async function loadI3S(url: string): Promise<unknown> {
  return Cesium.I3SDataProvider.fromUrl(url, {
    applySymbology: true,
    cesium3dTilesetOptions: { maximumScreenSpaceError: 16 },
  })
}

/** 加载 OGC 3D Tiles 数据集（tileset.json） */
export async function load3DTiles(url: string, options?: { maximumScreenSpaceError?: number }): Promise<unknown> {
  return Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 16, ...(options ?? {}) })
}
