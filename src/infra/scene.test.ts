import { describe, it, expect, vi, beforeEach } from 'vitest'
import '../testing/mocks/cesium'
import * as Cesium from 'cesium'
import { loadI3S, load3DTiles } from './scene'

describe('loadI3S', () => {
  const fromUrl = vi.mocked(Cesium.I3SDataProvider.fromUrl)

  beforeEach(() => fromUrl.mockClear())

  it('以 applySymbology + 内存预算选项调用 fromUrl', async () => {
    await expect(loadI3S('https://s/SceneServer')).resolves.toEqual({ prim: 'i3s' })
    expect(fromUrl).toHaveBeenCalledTimes(1)
    expect(fromUrl).toHaveBeenCalledWith('https://s/SceneServer', {
      applySymbology: true,
      cesium3dTilesetOptions: {
        maximumScreenSpaceError: 16,
        cacheBytes: 128 * 1024 * 1024,
        maximumCacheOverflowBytes: 32 * 1024 * 1024,
      },
    })
  })
})

describe('load3DTiles', () => {
  const fromUrl = vi.mocked(Cesium.Cesium3DTileset.fromUrl)

  beforeEach(() => fromUrl.mockClear())

  it('默认 SSE/缓存预算', async () => {
    await expect(load3DTiles('https://t/tileset.json')).resolves.toEqual({ tileset: '3d' })
    expect(fromUrl).toHaveBeenCalledWith('https://t/tileset.json', {
      maximumScreenSpaceError: 16,
      cacheBytes: 128 * 1024 * 1024,
      maximumCacheOverflowBytes: 32 * 1024 * 1024,
    })
  })

  it('选项可覆盖 maximumScreenSpaceError', async () => {
    await load3DTiles('https://t/tileset.json', { maximumScreenSpaceError: 24 })
    expect(fromUrl).toHaveBeenCalledWith('https://t/tileset.json', expect.objectContaining({ maximumScreenSpaceError: 24 }))
  })

  it('fromUrl 失败时原样向上抛错', async () => {
    fromUrl.mockRejectedValueOnce(new Error('tileset 404'))
    await expect(load3DTiles('https://t/missing.json')).rejects.toThrow('tileset 404')
  })
})
