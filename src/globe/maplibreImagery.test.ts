import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveStyleUrl,
  normalizeArcGisStyle,
  applyLabelLanguage,
  applyStyleOverrides,
  inferStyleUrl,
  styleUrlForLayer,
  tileCenterLngLat,
  blockKey,
  blockCenterIndex,
  indexToLngLat,
  cropTile,
  mapLibreRenderPlan,
  ArcGisVectorTileImageryProvider,
  type MapLike,
} from './facade/maplibreImagery'

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
      queueMicrotask(() => {
        this._emit('render')
        this._emit('idle')
      })
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
      queueMicrotask(() => {
        listeners['render']?.forEach((cb) => cb())
        listeners['idle']?.forEach((cb) => cb())
      })
      return map
    }),
    jumpTo: vi.fn(() => map),
    resize: vi.fn(() => map),
    getCanvas: vi.fn(() => document.createElement('canvas')),
    remove: vi.fn(),
    _emit(ev: string, ...args: unknown[]) {
      listeners[ev]?.forEach((cb) => cb(...args))
    },
    _listeners: listeners,
  }
  return map as unknown as MapLike & {
    jumpTo: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
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

  it('已有 tiles 的 vector source 保留并解析相对模板，移除 MapLibre 不支持的 tileSize', () => {
    const style = normalizeArcGisStyle(
      {
        sources: { vt: { type: 'vector', tiles: ['tiles/{z}/{y}/{x}.pbf'], tileSize: 512 } },
      },
      'https://cdn.example/styles/root.json'
    )
    const src = (style.sources as Record<string, { tiles?: string[]; tileSize?: number }>).vt
    expect(src.tiles?.[0]).toBe('https://cdn.example/styles/tiles/{z}/{y}/{x}.pbf')
    expect(src.tileSize).toBeUndefined()
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

  it('相对 VectorTileServer url 解析后转换为 XYZ tiles 模板', () => {
    const style = normalizeArcGisStyle(
      {
        sources: { esri: { type: 'vector', url: '../../' } },
      },
      'https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles/root.json'
    )
    const src = (style.sources as Record<string, { url?: string; tiles?: string[]; tileSize?: number }>).esri
    expect(src.url).toBeUndefined()
    expect(src.tiles?.[0]).toBe(
      'https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf'
    )
    expect(src.tileSize).toBeUndefined()
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
  it('原生 512px 输出让 Cesium 与 MapLibre 使用相同 zoom，避免缩放时坐标层级混用', () => {
    expect(mapLibreRenderPlan(0, 512)).toEqual({ mapZoom: 0, sourceScale: 1, viewportSize: 1536 })
    expect(mapLibreRenderPlan(4, 512)).toEqual({ mapZoom: 4, sourceScale: 1, viewportSize: 1536 })
  })

  it('blockKey 按 3x3 分块', () => {
    expect(blockKey(0, 0, 5)).toBe('5/0/0')
    expect(blockKey(3, 3, 5)).toBe('5/1/1')
    expect(blockKey(2, 8, 5)).toBe('5/0/2')
  })
  it('cropTile 按块中心计算裁剪偏移（内部块与边缘块）', () => {
    const snap = document.createElement('canvas')
    snap.width = 768
    snap.height = 768
    const drawCalls: number[][] = []
    const fakeCtx = {
      drawImage: (_src: unknown, sx: number, sy: number, ...rest: number[]) => {
        drawCalls.push([sx, sy, ...rest])
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D)
    try {
      // 内部块 z=4：瓦片 (4,4) → gx=3, cx=4.5 → sx=(4-3)*256=256, sy=256
      const out = cropTile(snap, 4, 4, 4, 256, 256)
      expect(out.width).toBe(256)
      expect(drawCalls[0]?.[0]).toBe(256)
      expect(drawCalls[0]?.[1]).toBe(256)
      drawCalls.length = 0
      // 内部块 z=4 瓦片 (3,0) → sx=0, sy=0
      cropTile(snap, 3, 0, 4, 256, 256)
      expect(drawCalls[0]?.[0]).toBe(0)
      expect(drawCalls[0]?.[1]).toBe(0)
      drawCalls.length = 0
      // 世界边缘块 z=2：瓦片 (3,3) → gx=3, cx=3.5（clamp 到唯一瓦片中心）→ sx=256, sy=256
      cropTile(snap, 3, 3, 2, 256, 256)
      expect(drawCalls[0]?.[0]).toBe(256)
      expect(drawCalls[0]?.[1]).toBe(256)
      drawCalls.length = 0
      // MapLibre 标准矢量瓦片为 512 CSS px：从 1536 快照裁 512px 并缩小为 Cesium 256px 瓦片
      const highRes = document.createElement('canvas')
      highRes.width = 1536
      highRes.height = 1536
      cropTile(highRes, 4, 4, 4, 256, 256, 2)
      expect(drawCalls[0]).toEqual([512, 512, 512, 512, 0, 0, 256, 256])
      drawCalls.length = 0
      // z2 东南边缘：1536px 视口无法以 tile (3,3) 的几何中心显示，MapLibre 会收拢到连续索引 (2.5,2.5)。
      // 必须按实际中心从 1024px 开始取 tile (3,3)，否则会错误取到 tile (2,2)。
      cropTile(highRes, 3, 3, 2, 512, 512, 1, { cx: 2.5, cy: 2.5 } as never)
      expect(drawCalls[0]).toEqual([1024, 1024, 512, 512, 0, 0, 512, 512])
      drawCalls.length = 0
      // 越界瓦片 → 透明（不调用 drawImage）
      cropTile(snap, 20, 20, 4, 256, 256)
      expect(drawCalls.length).toBe(0)
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('blockCenterIndex：内部块中心 = 中间瓦片；边缘块 clamp', () => {
    expect(blockCenterIndex(0, 0, 4)).toEqual({ cx: 1.5, cy: 1.5 })
    expect(blockCenterIndex(3, 3, 4)).toEqual({ cx: 4.5, cy: 4.5 })
    // z=2 东/南边缘块 gx=3：有效瓦片只有 3 → cx=3.5（瓦片 3 中心）
    expect(blockCenterIndex(3, 3, 2)).toEqual({ cx: 3.5, cy: 3.5 })
    // z=1 块 (0,0) 含瓦片 0,1：cx = (0+1+1)/2 = 1.0
    expect(blockCenterIndex(0, 0, 1)).toEqual({ cx: 1, cy: 1 })
  })
  it('indexToLngLat：连续索引 → 经纬度（0.5 = 瓦片 0 中心）', () => {
    expect(indexToLngLat(0.5, 0.5, 0)).toEqual({ lng: 0, lat: 0 })
    const c = indexToLngLat(1.5, 0.5, 1)
    expect(c.lng).toBeCloseTo(90, 5)
    expect(c.lat).toBeCloseTo(66.51326, 3)
  })
  it('块渲染中心 = 中间瓦片中心（不偏移半瓦片）', async () => {
    stubStyleFetch()
    const m = fakeMap()
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    await provider.readyPromise
    await provider.requestImage(0, 0, 2)
    const center = m.jumpTo.mock.calls[0][0].center as [number, number]
    const expectCenter = tileCenterLngLat(1, 1, 2)
    expect(center[0]).toBeCloseTo(expectCenter.lng, 5)
    expect(center[1]).toBeCloseTo(expectCenter.lat, 5)
    provider.destroy()
  })

  it('默认原生 512px 瓦片保持 MapLibre 视口和样式 zoom 与 Cesium 请求一致', async () => {
    stubStyleFetch()
    const m = fakeMap()
    let container: HTMLElement | undefined
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      createMap: (node) => {
        container = node
        return m
      },
    })
    await provider.readyPromise
    await provider.requestImage(4, 4, 4)
    expect(provider.tileWidth).toBe(512)
    expect(container?.style.width).toBe('1536px')
    expect(container?.style.height).toBe('1536px')
    expect(m.resize).not.toHaveBeenCalled()
    expect(m.jumpTo).toHaveBeenCalledWith({ center: expect.anything(), zoom: 4 })
    provider.destroy()
  })

  it('世界边缘被 MapLibre 收拢时，provider 按实际中心裁剪而非请求中心', async () => {
    stubStyleFetch()
    const m = fakeMap()
    const drawCalls: number[][] = []
    const fakeCtx = {
      drawImage: (_src: unknown, sx: number, sy: number, ...rest: number[]) => {
        drawCalls.push([sx, sy, ...rest])
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D)
    // 对 z2 的末行/末列，1536px 视口将请求中心 (3.5,3.5) 收拢为 (2.5,2.5)。
    m.getCenter = vi.fn(() => ({ lng: 45, lat: -40.97989806962013 }))
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', createMap: () => m })
    try {
      await provider.readyPromise
      await provider.requestImage(3, 3, 2)
      expect(m.getCenter).toHaveBeenCalled()
      expect(drawCalls).toContainEqual([1024, 1024, 512, 512, 0, 0, 512, 512])
    } finally {
      provider.destroy()
      vi.restoreAllMocks()
    }
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
    expect(provider.tileWidth).toBe(512)
    expect(provider.tileHeight).toBe(512)
    expect(provider.minimumLevel).toBe(0)
    expect(provider.maximumLevel).toBe(16)
    expect(provider.rectangle).toBeDefined()
    expect(provider.hasAlphaChannel).toBe(true)
    expect(provider.errorEvent).toBeDefined()
    expect(provider.getTileCredits()).toEqual([])

    const m = createMap()
    const canvas = await provider.requestImage(1, 0, 1)
    expect(canvas).toBeDefined()
    expect((canvas as HTMLCanvasElement).width).toBe(512)
    expect((canvas as HTMLCanvasElement).height).toBe(512)
    expect(m.jumpTo).toHaveBeenCalledWith({ center: expect.anything(), zoom: 1 })
    provider.destroy()
  })

  it('MapLibre 使用 3x3 原生 512px 视口，读取原生 1x 快照后原尺寸裁剪为 Cesium 瓦片', async () => {
    const m = fakeMap()
    let container: HTMLElement | undefined
    let renderPixelRatio: number | undefined
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      createMap: (node, _style, pixelRatio) => {
        container = node
        renderPixelRatio = pixelRatio
        setTimeout(() => m._emit('load'), 0)
        return m
      },
    })
    await provider.readyPromise
    expect(container?.style.width).toBe('1536px')
    expect(container?.style.height).toBe('1536px')
    expect(provider.tileWidth).toBe(512)
    expect(provider.tileHeight).toBe(512)
    expect(renderPixelRatio).toBe(1)
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

  it('等待 MapLibre idle 后才截取块快照，避免缓存尚未下载的透明区域', async () => {
    const m = fakeMap()
    let repaints = 0
    m.triggerRepaint = vi.fn(() => {
      repaints += 1
      queueMicrotask(() => {
        m._emit('render')
        // 初始化预热可以完成；请求瓦片时故意不发 idle。
        if (repaints === 1) m._emit('idle')
      })
      return m
    }) as never
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', mapPoolSize: 1, createMap: () => m })
    try {
      await provider.readyPromise
      const pending = provider.requestImage(0, 0, 2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(m.getCanvas).not.toHaveBeenCalled()
      m._emit('idle')
      await expect(pending).resolves.toBeDefined()
    } finally {
      provider.destroy()
    }
  })

  it('并发请求不同块时，忙碌中的 Map 实例不会被再次派发（同一 canvas 严格串行）', async () => {
    stubStyleFetch()
    const mkControllable = () => {
      const m = fakeMap()
      let repaints = 0
      m.triggerRepaint = vi.fn(() => {
        repaints += 1
        queueMicrotask(() => {
          m._emit('render')
          // 初始化预热（第 1 次）可以 idle；块渲染故意挂起，等测试手动释放
          if (repaints === 1) m._emit('idle')
        })
        return m
      }) as never
      return m
    }
    const m1 = mkControllable()
    const m2 = mkControllable()
    let created = 0
    setTimeout(() => m1._emit('load'), 0)
    setTimeout(() => m2._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      mapPoolSize: 2,
      createMap: () => (created++ === 0 ? m1 : m2),
    })
    try {
      await provider.readyPromise
      const pA = provider.requestImage(0, 0, 2) // 块 2/0/0 → m1
      const pB = provider.requestImage(3, 0, 2) // 块 2/1/0 → m2
      const pC = provider.requestImage(0, 3, 2)! // 块 2/0/1：两实例都忙，必须排队
      // 关键断言：C 不能落到仍在渲染的 m1（旧轮询实现会跳回 m1 → 同一 canvas 并发 → 块内容整体错位）
      expect(m1.jumpTo).toHaveBeenCalledTimes(1)
      expect(m2.jumpTo).toHaveBeenCalledTimes(1)
      let cSettled = false
      pC.then(
        () => {
          cSettled = true
        },
        () => {
          cSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cSettled).toBe(false)
      // 释放 m1：A 完成后 C 才被派到 m1（此时 m1 已空闲）
      m1._emit('idle')
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(m1.jumpTo).toHaveBeenCalledTimes(2)
      expect(cSettled).toBe(false)
      // 释放 m1（C）与 m2（B）
      m1._emit('idle')
      m2._emit('idle')
      await expect(pA).resolves.toBeDefined()
      await expect(pB).resolves.toBeDefined()
      await expect(pC).resolves.toBeDefined()
    } finally {
      provider.destroy()
    }
  })

  it('默认 createMap 走真实 MapLibre 构造路径（离屏渲染）', async () => {
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json' })
    await provider.readyPromise
    expect(provider.ready).toBe(true)
    const canvas = await provider.requestImage(0, 0, 0)
    expect(canvas).toBeDefined()
    expect((canvas as HTMLCanvasElement).width).toBe(512)
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
        else {
          m._emit('render')
          m._emit('idle')
        }
      })
      return m
    }) as never
    const provider = new ArcGisVectorTileImageryProvider({ styleUrl: 'https://x/root.json', mapPoolSize: 1, createMap: () => m })
    await provider.readyPromise
    await expect(provider.requestImage(0, 0, 0)).rejects.toThrow(/render boom/)
    const ok = await provider.requestImage(1, 0, 1)
    expect(ok).toBeDefined()
    provider.destroy()
  })
})

describe('applyStyleOverrides', () => {
  it('字号倍数支持数值和 stops，并设置字体/颜色/描边', () => {
    const style = applyStyleOverrides(
      {
        layers: [
          { id: 'a', type: 'symbol', layout: { 'text-field': '{_name}', 'text-size': 12 }, paint: {} },
          { id: 'b', type: 'symbol', layout: { 'text-field': '{_name}', 'text-size': { base: 1.2, stops: [[3, 9], [10, 13]] } }, paint: {} },
          { id: 'fill', type: 'fill', layout: {} },
        ],
      },
      {
        textScale: 1.5,
        textFont: ['Libertinus Sans Regular'],
        textColor: '#000000',
        haloColor: '#d5dcc8',
        haloWidth: 1,
      }
    )
    const layers = style.layers as Array<{ layout: { 'text-size': unknown; 'text-font'?: unknown }; paint: Record<string, unknown> }>
    expect(layers[0].layout['text-size']).toBe(18)
    expect(layers[0].layout['text-font']).toEqual(['Libertinus Sans Regular'])
    expect(layers[0].paint['text-color']).toBe('#000000')
    expect(layers[0].paint['text-halo-color']).toBe('#d5dcc8')
    expect(layers[0].paint['text-halo-width']).toBe(1)
    expect(layers[1].layout['text-size']).toEqual({ base: 1.2, stops: [[3, 13.5], [10, 19.5]] })
    expect(layers[2].layout['text-size']).toBeUndefined()
  })

  it('字号梯度：低级小倍率、高级大倍率，按停点 zoom 逐个缩放', () => {
    const style = applyStyleOverrides(
      {
        layers: [
          { id: 'city', type: 'symbol', layout: { 'text-field': '{_name}', 'text-size': { base: 1.2, stops: [[4, 10], [10, 14], [16, 20]] } } },
        ],
      },
      { textScale: { lowZoom: 6, highZoom: 16, lowScale: 1.15, highScale: 1.6 } }
    )
    const l = (style.layers as Array<{ layout: { 'text-size': { stops: number[][] } } }>)[0]
    const stops = l.layout['text-size'].stops
    expect(stops[0][0]).toBe(4)
    expect(stops[0][1]).toBeCloseTo(11.5, 5)
    expect(stops[1][0]).toBe(10)
    expect(stops[1][1]).toBeCloseTo(18.62, 5)
    expect(stops[2]).toEqual([16, 32])
  })

  it('labelScope country-city 保留 Place/Unclassified 层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          version: 8,
          sources: { esri: { type: 'vector', url: 'https://basemaps.example/World_Basemap_v2/VectorTileServer' } },
          layers: [
            { id: 'Place/Unclassified', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Place/POI Other/Color6', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Admin0 point/medium', type: 'symbol', layout: { 'text-field': '{_name}' } },
          ],
        }),
      }))
    )
    const m = fakeMap()
    const seenStyles: unknown[] = []
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      labelsOnly: true,
      labelScope: 'country-city',
      createMap: (_node, style) => {
        seenStyles.push(style)
        return m
      },
    })
    await provider.readyPromise
    const layers = (seenStyles[0] as { layers: Array<{ id: string }> }).layers
    expect(layers.map((l) => l.id)).toEqual(['Place/Unclassified', 'Admin0 point/medium'])
    provider.destroy()
  })
})

describe('world-edge block center', () => {
  it('MapLibre 返回过期中心时，裁剪仍使用钳制后的预期中心', async () => {
    stubStyleFetch()
    const m = fakeMap()
    const drawCalls: number[][] = []
    const fakeCtx = {
      drawImage: (_src: unknown, sx: number, sy: number, ...rest: number[]) => {
        drawCalls.push([sx, sy, ...rest])
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D)
    // 模拟并发时取到的旧中心：z3 东边缘块（瓦片 x=6..7）预期中心经钳制后 lng=112.5（cx=6.5），但 getCenter 返回 22.5
    m.getCenter = vi.fn(() => ({ lng: 22.5, lat: 0 }))
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      mapPoolSize: 1,
      createMap: () => m,
    })
    try {
      await provider.readyPromise
      await provider.requestImage(6, 0, 3)
      // tile x=6 位于块中间位置：sx=(6-(6.5-1.5))*512=512
      expect(drawCalls.some((c) => c[0] === 512 && c[1] === 0 && c[4] === 0 && c[5] === 0)).toBe(true)
    } finally {
      provider.destroy()
      vi.restoreAllMocks()
    }
  })
})

describe('labelsOnly', () => {
  it('仅保留带 text-field 的 symbol 图层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          version: 8,
          sources: { esri: { type: 'vector', url: 'https://basemaps.example/World_Basemap_v2/VectorTileServer' } },
          layers: [
            { id: 'bg', type: 'background' },
            { id: 'fill', type: 'fill', layout: {} },
            { id: 'line', type: 'line', layout: {} },
            { id: 'label', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'labelExpr', type: 'symbol', layout: { 'text-field': ['coalesce', ['get', '_name_en'], ['get', '_name']] } },
            { id: 'place', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'city', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'icon', type: 'symbol', layout: {} },
          ],
        }),
      }))
    )
    const m = fakeMap()
    const seenStyles: unknown[] = []
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      labelsOnly: true,
      createMap: (_node, style) => {
        seenStyles.push(style)
        return m
      },
    })
    await provider.readyPromise
    const layers = (seenStyles[0] as { layers: Array<{ id: string }> }).layers
    expect(layers.map((l) => l.id)).toEqual(['label', 'labelExpr', 'place', 'city'])
    provider.destroy()
  })

  it('labelScope country-city 只保留主要地名层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          version: 8,
          sources: { esri: { type: 'vector', url: 'https://basemaps.example/World_Basemap_v2/VectorTileServer' } },
          layers: [
            { id: 'Continent', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Admin0 point', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'City large scale', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Place/Unclassified', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Admin0 forest or park/label', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Water point/Sea or ocean', type: 'symbol', layout: { 'text-field': '{_name}' } },
            { id: 'Road', type: 'symbol', layout: { 'text-field': '{_name}' } },
          ],
        }),
      }))
    )
    const m = fakeMap()
    const seenStyles: unknown[] = []
    setTimeout(() => m._emit('load'), 0)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: 'https://x/root.json',
      labelsOnly: true,
      labelScope: 'country-city',
      createMap: (_node, style) => {
        seenStyles.push(style)
        return m
      },
    })
    await provider.readyPromise
    const layers = (seenStyles[0] as { layers: Array<{ id: string }> }).layers
    expect(layers.map((l) => l.id)).toEqual(['Continent', 'Admin0 point', 'City large scale', 'Place/Unclassified'])
    provider.destroy()
  })
})

describe('applyLabelLanguage', () => {
  it('applyLabelLanguage: en 优先英文并回退', () => {
    const style = applyLabelLanguage(
      {
        layers: [
          { id: 'place', type: 'symbol', layout: { 'text-field': '{_name}' } },
          { id: 'water', type: 'symbol', layout: { 'text-field': '{_name_global}' } },
          { id: 'fill', type: 'fill', layout: {} },
        ],
      },
      'en'
    )
    const layers = style.layers as Array<{ layout: { 'text-field': unknown } }>
    const expected = ['coalesce', ['get', '_name_en'], ['get', '_name_global'], ['get', '_name']]
    expect(layers[0].layout['text-field']).toEqual(expected)
    expect(layers[1].layout['text-field']).toEqual(expected)
    expect(layers[2].layout['text-field']).toBeUndefined()
  })

  it('applyLabelLanguage: local 把水系全球名换成当地名', () => {
    const style = applyLabelLanguage(
      {
        layers: [
          { id: 'water', type: 'symbol', layout: { 'text-field': '{_name_global}' } },
          { id: 'place', type: 'symbol', layout: { 'text-field': '{_name}' } },
        ],
      },
      'local'
    )
    const layers = style.layers as Array<{ layout: { 'text-field': unknown } }>
    expect(layers[0].layout['text-field']).toBe('{_name_local}')
    expect(layers[1].layout['text-field']).toBe('{_name}')
  })

})
