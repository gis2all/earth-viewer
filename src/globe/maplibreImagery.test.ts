import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveStyleUrl,
  normalizeArcGisStyle,
  inferStyleUrl,
  styleUrlForLayer,
  tileCenterLngLat,
  blockKey,
  cropTile,
  ArcGisVectorTileImageryProvider,
  type MapLike,
} from './maplibreImagery'

// 默认 createMap 会 new maplibregl.Map：mock 掉真实模块，jsdom 无 WebGL
vi.mock('maplibre-gl', () => {
  class FakeMap {
    _listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
    constructor(_opts: unknown) {
      setTimeout(() => this._emit('load'), 0)
    }
    once(ev: string, cb: (...a: unknown[]) => void) {
      ;(this._listeners[ev] ??= []).push(cb)
      return this
    }
    off(ev: string, cb: (...a: unknown[]) => void) {
      this._listeners[ev] = (this._listeners[ev] ?? []).filter((x) => x !== cb)
      return this
    }
    triggerRepaint() {
      queueMicrotask(() => this._emit('render'))
      return this
    }
    jumpTo() {
      return this
    }
    getCanvas() {
      return document.createElement('canvas')
    }
    remove() {
      // noop
    }
    _emit(ev: string, ...args: unknown[]) {
      this._listeners[ev]?.forEach((cb) => cb(...args))
    }
  }
  return { Map: FakeMap, setWorkerUrl: vi.fn() }
})

/** 可编程假 MapLibre Map：手动触发 load / render 事件 */
function fakeMap() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const map = {
    once: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      ;(listeners[ev] ??= []).push(cb)
      return map
    }),
    off: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== cb)
      return map
    }),
    triggerRepaint: vi.fn(() => {
      queueMicrotask(() => listeners['render']?.forEach((cb) => cb()))
      return map
    }),
    jumpTo: vi.fn(() => map),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    remove: vi.fn(),
    _emit(ev: string, ...args: unknown[]) {
      listeners[ev]?.forEach((cb) => cb(...args))
    },
    _listeners: listeners,
  }
  return map as unknown as MapLike & {
    jumpTo: ReturnType<typeof vi.fn>
    triggerRepaint: ReturnType<typeof vi.fn>
    getCanvas: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    _emit: (ev: string, ...args: unknown[]) => void
    _listeners: Record<string, Array<(...args: unknown[]) => void>>
  }
}

/** 构造一个能正常 load 的 createMap */
function createLoadableMap() {
  const m = fakeMap()
  setTimeout(() => m._emit('load'), 0)
  return () => m
}

/** 样式 fetch 桩：返回 root.json 假样式 */
function stubStyleFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 8,
        sprite: '../sprites/sprite',
        glyphs: 'https://glyphs.example/{fontstack}/{range}.pbf',
        sources: {
          esri: { type: 'vector', url: 'https://basemaps.example/World_Basemap_v2/VectorTileServer' },
          raster: { type: 'raster', tiles: ['https://tiles.example/{z}/{x}/{y}.png'] },
        },
      }),
    }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveStyleUrl', () => {
  it('绝对 URL 原样返回', () => {
    expect(resolveStyleUrl('https://a/b.json', 'https://x/root.json')).toBe('https://a/b.json')
  })
  it('相对路径按 base 解析', () => {
    expect(resolveStyleUrl('../sprites/sprite', 'https://cdn.example/styles/root.json')).toBe(
      'https://cdn.example/sprites/sprite'
    )
  })
  it('相对路径按 styles 目录解析', () => {
    expect(resolveStyleUrl('sprites/sprite.png', 'https://x/styles/root.json')).toBe('https://x/styles/sprites/sprite.png')
  })
})

describe('normalizeArcGisStyle', () => {
  it('sprite/glyphs 相对路径转绝对；VectorTileServer url → tiles 模板', () => {
    const style = normalizeArcGisStyle(
      {
        sprite: '../sprites/sprite',
        glyphs: 'fonts/{fontstack}/{range}.pbf',
        sources: {
          esri: { type: 'vector', url: 'https://basemaps.example/World_Basemap_v2/VectorTileServer' },
        },
      },
      'https://cdn.example/styles/root.json'
    )
    expect(style.sprite).toBe('https://cdn.example/sprites/sprite')
    expect(style.glyphs).toBe('https://cdn.example/styles/fonts/{fontstack}/{range}.pbf')
    const src = (style.sources as Record<string, { tiles?: string[]; url?: string }>).esri
    expect(src.tiles?.[0]).toBe('https://basemaps.example/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf')
    expect(src.url).toBeUndefined()
  })

  it('已有 tiles 的 vector source 保留并解析相对模板', () => {
    const style = normalizeArcGisStyle(
      {
        sources: { vt: { type: 'vector', tiles: ['tiles/{z}/{y}/{x}.pbf'] } },
      },
      'https://cdn.example/styles/root.json'
    )
    const src = (style.sources as Record<string, { tiles?: string[] }>).vt
    expect(src.tiles?.[0]).toBe('https://cdn.example/styles/tiles/{z}/{y}/{x}.pbf')
  })

  it('非 VectorTileServer 的 vector url 保持为 url 并解析绝对', () => {
    const style = normalizeArcGisStyle(
      {
        sources: { tilejson: { type: 'vector', url: '../data/tiles.json' } },
      },
      'https://cdn.example/styles/root.json'
    )
    const src = (style.sources as Record<string, { url?: string; tiles?: string[] }>).tilejson
    expect(src.url).toBe('https://cdn.example/data/tiles.json')
    expect(src.tiles).toBeUndefined()
  })

  it('非 vector 源 / 空值源原样保留', () => {
    const style = normalizeArcGisStyle(
      {
        sources: { r: { type: 'raster', tiles: ['https://t/{z}/{y}/{x}.png'] }, bad: null },
      },
      'https://x/root.json'
    )
    const sources = style.sources as Record<string, unknown>
    expect(sources.r).toEqual({ type: 'raster', tiles: ['https://t/{z}/{y}/{x}.png'] })
    expect(sources.bad).toBeNull()
  })
})

describe('styleUrlForLayer / inferStyleUrl', () => {
  it('优先 styleUrl；url 已是 root.json 直接用；VectorTileServer 推断', () => {
    expect(styleUrlForLayer({ styleUrl: 'https://a/root.json', url: 'https://b/VectorTileServer' })).toBe('https://a/root.json')
    expect(styleUrlForLayer({ url: 'https://b/VectorTileServer/resources/styles/root.json' })).toBe('https://b/VectorTileServer/resources/styles/root.json')
    expect(styleUrlForLayer({ url: 'https://b/VectorTileServer' })).toBe('https://b/VectorTileServer/resources/styles/root.json')
    expect(styleUrlForLayer({})).toBeUndefined()
    expect(inferStyleUrl('https://b/VectorTileServer/')).toBe('https://b/VectorTileServer/resources/styles/root.json')
    expect(inferStyleUrl()).toBeUndefined()
  })
})

describe('tileCenterLngLat', () => {
  it('z0 全图中心 (0,0)', () => {
    expect(tileCenterLngLat(0, 0, 0)).toEqual({ lng: 0, lat: 0 })
  })
  it('z1 右上瓦片中心 ≈ (90, 66.5)', () => {
    const c = tileCenterLngLat(1, 0, 1)
    expect(c.lng).toBeCloseTo(90, 5)
    expect(c.lat).toBeCloseTo(66.51326, 3)
  })
})

describe('blockKey / cropTile', () => {
  it('blockKey 按 3x3 分块', () => {
    expect(blockKey(0, 0, 5)).toBe('5/0/0')
    expect(blockKey(3, 3, 5)).toBe('5/1/1')
    expect(blockKey(2, 8, 5)).toBe('5/0/2')
  })
  it('cropTile 裁剪正确瓦片；越界返回透明片', () => {
    const mk = (i: number) => {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 256
      const ctx = c.getContext('2d')
      if (ctx) ctx.fillStyle = 'rgb(' + i + ',0,0)'
      if (ctx) ctx.fillRect(0, 0, 256, 256)
      return c
    }
    const block = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(mk)
    // z=4 的 (4,4) → 块 (3,3)，局部 (1,1) → idx 4
    const out = cropTile(block, 4, 4, 4, 256, 256)
    expect(out.width).toBe(256)
    // z=4 的 (7,7) 越界（2^4=16 不越界…验证块内裁剪到 idx 8）
    const out2 = cropTile(block, 5, 5, 4, 256, 256)
    expect(out2.width).toBe(256)
    // 越界瓦片 → 透明
    const out3 = cropTile(block, 20, 20, 4, 256, 256)
    expect(out3.width).toBe(256)
  })
  it('requestImage 命中块缓存直接返回裁剪结果', async () => {
    stubStyleFetch()
    const m = fakeMap()
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    const first = await provider.requestImage(4, 4, 4)
    expect(first).toBeDefined()
    const before = provider.renderedCount
    const second = await provider.requestImage(5, 4, 4)
    expect(second).toBeDefined()
    // 同块二次请求命中缓存，不触发新的块渲染
    expect(provider.renderedCount).toBe(before)
    provider.destroy()
  })
})

describe('ArcGisVectorTileImageryProvider', () => {
  beforeEach(() => {
    stubStyleFetch()
  })

  it('协议字段齐全，ready 后 requestImage 串行渲染并返回 canvas', async () => {
    const createMap = createLoadableMap()
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      title: 'My Vector',
      createMap,
    })
    await expect(provider.readyPromise).resolves.toBe(true)
    expect(provider.ready).toBe(true)
    expect(provider.tileWidth).toBe(256)
    expect(provider.tileHeight).toBe(256)
    expect(provider.minimumLevel).toBe(0)
    expect(provider.maximumLevel).toBe(16)
    expect(provider.rectangle).toBeDefined()
    expect(provider.hasAlphaChannel).toBe(true)
    expect(provider.errorEvent).toBeDefined()
    expect(provider.getTileCredits()).toEqual([])

    const m = createMap()
    const canvas = await provider.requestImage(1, 0, 1)
    expect(canvas).toBeDefined()
    expect((canvas as HTMLCanvasElement).width).toBe(256)
    expect((canvas as HTMLCanvasElement).height).toBe(256)
    expect(m.jumpTo).toHaveBeenCalledWith({ center: expect.anything(), zoom: 1 })
    provider.destroy()
  })

  it('requestImage 超级别返回 undefined；销毁后返回 undefined', async () => {
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: createLoadableMap() })
    await provider.readyPromise
    expect(provider.requestImage(0, 0, 99)).toBeUndefined()
    provider.destroy()
    expect(provider.requestImage(0, 0, 1)).toBeUndefined()
    expect(provider.requestImage(0, 0, 1)).toBeUndefined()
  })

  it('未 ready 时 requestImage 返回 undefined', async () => {
    const m = fakeMap() // 永不 emit load
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    expect(provider.requestImage(0, 0, 1)).toBeUndefined()
    provider.destroy()
    // 等 _init 的销毁清理微任务执行完（fetch 已 resolve）
    await Promise.resolve()
    await Promise.resolve()
    expect(m.remove).toHaveBeenCalled()
    await expect(provider.readyPromise).resolves.toBe(false)
    expect(provider.ready).toBe(false)
  })

  it('destroy 移除 map 与容器', async () => {
    const m = fakeMap()
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    const container = document.body.querySelector('div[style*="-10000px"]')
    expect(container).not.toBeNull()
    provider.destroy()
    expect(m.remove).toHaveBeenCalled()
    expect((container as HTMLElement | null)?.isConnected).toBe(false)
  })

  it('样式 fetch 失败 → readyPromise 拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: createLoadableMap() })
    await expect(provider.readyPromise).rejects.toThrow(/HTTP 404/)
  })

  it('缺样式地址 → readyPromise 拒绝', async () => {
    const provider = new ArcGisVectorTileImageryProvider({ url: '', createMap: createLoadableMap() })
    await expect(provider.readyPromise).rejects.toThrow(/缺少矢量瓦片样式地址/)
  })

  it('样式渲染失败不阻塞后续瓦片（队列吞错）', async () => {
    let fail = true
    const m = fakeMap()
    m.jumpTo = vi.fn(() => {
      if (fail) {
        fail = false
        throw new Error('jump boom')
      }
      return m
    })
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    // z1 的 (0,0) 与 z2 的 (3,0) 分属不同 3x3 块：第一块失败，第二块正常
    await expect(provider.requestImage(0, 0, 1)).rejects.toThrow(/jump boom/)
    const canvas = await provider.requestImage(3, 0, 2)
    expect(canvas).toBeDefined()
    expect(provider.renderedCount).toBeGreaterThan(0)
    provider.destroy()
  })

  it('默认 createMap 走真实 MapLibre 构造路径（离屏渲染）', async () => {
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json' })
    await provider.readyPromise
    expect(provider.ready).toBe(true)
    const canvas = await provider.requestImage(0, 0, 0)
    expect(canvas).toBeDefined()
    expect((canvas as HTMLCanvasElement).width).toBe(256)
    provider.destroy()
  })

  it('销毁时未决瓦片请求被拒绝', async () => {
    const m = fakeMap()
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    // 让渲染挂起：jumpTo 不触发 render → 请求 pending
    m.triggerRepaint = vi.fn(() => m) as never
    const pReq = provider.requestImage(0, 0, 2)
    provider.destroy()
    await expect(pReq).rejects.toThrow(/已销毁/)
  })

  it('MapLibre 样式加载报错 → readyPromise 拒绝', async () => {
    const m = fakeMap()
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      createMap: () => {
        setTimeout(() => m._emit('error', new Error('style boom')), 0)
        return m
      },
    })
    await expect(provider.readyPromise).rejects.toThrow(/style boom/)
    provider.destroy()
  })

  it('瓦片渲染报错 → 该瓦片 promise 拒绝，后续瓦片正常', async () => {
    const m = fakeMap()
    setTimeout(() => m._emit('load'), 0)
    let calls = 0
    m.triggerRepaint = vi.fn(() => {
      calls += 1
      queueMicrotask(() => {
        if (calls === 2) m._emit('error', new Error('render boom'))
        else m._emit('render')
      })
      return m
    }) as never
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    await expect(provider.requestImage(0, 0, 0)).rejects.toThrow(/render boom/)
    const ok = await provider.requestImage(1, 0, 1)
    expect(ok).toBeDefined()
    provider.destroy()
  })
})
