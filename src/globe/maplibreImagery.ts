import * as Cesium from 'cesium'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre 的 worker 通过 new URL(..., import.meta.url) 动态加载，vite 无法静态解析 → 显式 ?worker&url 打包（内联依赖）并 setWorkerUrl
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { withFetchTimeout } from './webmap'
import { SAFETY } from './loadSafety'

// 批量渲染块尺寸：一帧 MapLibre 渲染 3x3 瓦片，读回次数降为 1/9（避免与 Cesium 抢 GPU 导致每片 1s+ 的读回停顿）
const BLOCK = 3
// 块缓存上限（LRU）：最近 48 个块 ≈ 432 片，防止相机回访时重复渲染
const BLOCK_CACHE_LIMIT = 48

/**
 * MapLibre → Cesium ImageryProvider 桥（方案 A）。
 *
 * ArcGIS VectorTileLayer 的官方样式是 Mapbox Style v8 变体（root.json）。
 * 这里用真实的 MapLibre GL 离屏渲染每张瓦片（含 sprite/glyphs/完整 paint 规则），
 * 再把结果作为 canvas 返回给 Cesium 的 ImageryLayer —— 与 ArcGIS Map Viewer 观感一致，
 * 且不会像 MVTDataProvider 那样把全球矢量几何解码成 3D Tiles 导致内存爆炸。
 */

/** 把相对路径按样式地址解析为绝对 URL（ArcGIS root.json 常用 ../ 相对 sprite/glyphs） */
export function resolveStyleUrl(raw: string, baseUrl: string): string {
  try {
    // URL 解析会把 { } 编码成 %7B/%7D；MapLibre 模板（glyphs/tiles）需要字面量占位符
    return new URL(raw, baseUrl).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
  } catch {
    return raw
  }
}

export interface StyleSource {
  type?: string
  url?: string
  tiles?: string[]
  [key: string]: unknown
}

/**
 * 规范化 ArcGIS root.json 为 MapLibre 可用样式：
 * - sprite / glyphs 相对路径 → 相对样式地址解析为绝对 URL
 * - vector source 的 url 指向 VectorTileServer → 改写成 {z}/{y}/{x}.pbf tiles 模板
 *   （MapLibre 的 url 字段期望是 TileJSON 端点，VectorTileServer 不是；已有 tiles 的保留并解析相对模板）
 */
export function normalizeArcGisStyle(style: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...style }
  if (typeof out.sprite === 'string') out.sprite = resolveStyleUrl(out.sprite, baseUrl)
  if (typeof out.glyphs === 'string') out.glyphs = resolveStyleUrl(out.glyphs, baseUrl)
  const sources = (out.sources ?? {}) as Record<string, StyleSource>
  const next: Record<string, StyleSource> = {}
  for (const [name, src] of Object.entries(sources)) {
    if (!src || typeof src !== 'object') {
      next[name] = src
      continue
    }
    const s: StyleSource = { ...src }
    if (s.type === 'vector') {
      if (Array.isArray(s.tiles) && s.tiles.length > 0) {
        s.tiles = s.tiles.map((t) => resolveStyleUrl(t, baseUrl))
        delete s.url
      } else if (typeof s.url === 'string' && s.url.length > 0) {
        if (/\/VectorTileServer\/?$/i.test(s.url)) {
          s.tiles = [resolveStyleUrl(s.url, baseUrl).replace(/\/?$/, '') + '/tile/{z}/{y}/{x}.pbf']
          delete s.url
        } else {
          s.url = resolveStyleUrl(s.url, baseUrl)
        }
      }
    }
    next[name] = s
  }
  out.sources = next
  return out
}

/** 从 VectorTileServer 地址推断样式地址（{url}/resources/styles/root.json） */
export function inferStyleUrl(url?: string): string | undefined {
  if (!url) return undefined
  return url.replace(/\/?$/, '') + '/resources/styles/root.json'
}

/** 图层 → 样式地址：优先 styleUrl；url 已是 root.json 直接用；否则按 VectorTileServer 推断 */
export function styleUrlForLayer(layer: { styleUrl?: string; url?: string }): string | undefined {
  if (layer.styleUrl) return layer.styleUrl
  const u = layer.url
  if (!u) return undefined
  if (/\/styles\/root\.json$/i.test(u)) return u
  return inferStyleUrl(u)
}

/** WebMercator 瓦片中心经纬度（Cesium WebMercatorTilingScheme 与 MapLibre 的 y 都从北向南，可直接用） */
export function tileCenterLngLat(x: number, y: number, z: number): { lng: number; lat: number } {
  const n = 2 ** z
  const lng = ((x + 0.5) / n) * 360 - 180
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * (180 / Math.PI)
  return { lng, lat }
}

/** 瓦片所属 3x3 块缓存键（块内任意一片命中即整块命中） */
export function blockKey(x: number, y: number, z: number): string {
  return z + '/' + Math.floor(x / BLOCK) + '/' + Math.floor(y / BLOCK)
}

/** 从 3x3 块 canvas 数组中裁剪指定瓦片（块外/越界位置返回透明片） */
export function cropTile(
  block: HTMLCanvasElement[],
  x: number,
  y: number,
  z: number,
  tileWidth: number,
  tileHeight: number
): HTMLCanvasElement {
  const gx = Math.floor(x / BLOCK) * BLOCK
  const gy = Math.floor(y / BLOCK) * BLOCK
  const lx = x - gx
  const ly = y - gy
  const n = 2 ** z
  if (x < 0 || y < 0 || x >= n || y >= n || lx < 0 || lx >= BLOCK || ly < 0 || ly >= BLOCK) {
    const blank = document.createElement('canvas')
    blank.width = tileWidth
    blank.height = tileHeight
    return blank
  }
  const idx = ly * BLOCK + lx
  const src = block[idx]
  const out = document.createElement('canvas')
  out.width = tileWidth
  out.height = tileHeight
  const ctx = out.getContext('2d')
  if (ctx && src) ctx.drawImage(src, 0, 0, tileWidth, tileHeight)
  return out
}

/** MapLibre Map 的测试友好最小接口 */
export interface MapLike {
  once(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  triggerRepaint(): void
  jumpTo(options: { center: [number, number]; zoom: number }): unknown
  getCanvas(): HTMLCanvasElement
  remove(): void
}

export interface VectorTileImageryOptions {
  /** 样式地址（root.json）；缺省用 url 推断 */
  styleUrl?: string
  /** VectorTileServer 地址（推断 styleUrl 用） */
  url?: string
  title?: string
  tileSize?: number
  minimumLevel?: number
  maximumLevel?: number
  signal?: AbortSignal
  /** 测试注入：替换真实 MapLibre Map 构造 */
  createMap?: (container: HTMLElement, style: unknown) => MapLike
}

/** 默认 Map 构造：真实 MapLibre GL 离屏渲染（隐藏容器 + preserveDrawingBuffer 读像素） */
function defaultCreateMap(container: HTMLElement, style: unknown): MapLike {
  // 让 maplibre 用打包后的 worker（否则 dev 下 worker 404 → 样式永不 load）
  maplibregl.setWorkerUrl(maplibreWorkerUrl)
  return new maplibregl.Map({
    container: container as HTMLDivElement,
    style: style as maplibregl.StyleSpecification,
    center: [0, 0],
    zoom: 0,
    bearing: 0,
    pitch: 0,
    interactive: false,
    attributionControl: false,
    renderWorldCopies: false,
    fadeDuration: 0,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    // 离屏批量渲染用 1x 像素比：读回与裁剪按 1:1，避免 DPR 缩放出错
    pixelRatio: 1,
  }) as unknown as MapLike
}

/** 等待单个 MapLibre 事件（load/error），带超时 */
function waitForEvent(map: MapLike, event: string, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(label + '超时'))
    }, timeoutMs)
    const onOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const cleanup = () => {
      map.off(event, onOk)
      map.off('error', onError)
      window.clearTimeout(timer)
    }
    map.once(event, onOk)
    map.once('error', onError)
  })
}

/** 触发一帧渲染并等待 render 事件（MapLibre 离屏渲染的主流程） */
function waitForMapRender(map: MapLike, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('MapLibre 渲染超时'))
    }, timeoutMs)
    const onRender = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const cleanup = () => {
      map.off('render', onRender)
      map.off('error', onError)
      window.clearTimeout(timer)
    }
    map.once('render', onRender)
    map.once('error', onError)
    map.triggerRepaint()
  })
}

/**
 * 用 MapLibre 按 ArcGIS 官方样式渲染矢量瓦片的 Cesium ImageryProvider。
 * requestImage 串行渲染（共享一个隐藏 Map，避免相机竞态），返回 256px canvas。
 * 只实现 ImageryProvider 协议字段，交给 Cesium.ImageryLayer 消费（鸭子类型，不继承基类）。
 */
export class ArcGisVectorTileImageryProvider {
  readonly tilingScheme = new Cesium.WebMercatorTilingScheme()
  readonly rectangle: Cesium.Rectangle
  readonly tileWidth: number
  readonly tileHeight: number
  readonly minimumLevel: number
  readonly maximumLevel: number
  readonly tileDiscardPolicy: Cesium.TileDiscardPolicy | undefined = undefined
  readonly errorEvent = new Cesium.Event()
  readonly credit: Cesium.Credit
  readonly proxy: Cesium.Proxy | undefined = undefined
  readonly hasAlphaChannel = true
  ready = false
  readyPromise: Promise<boolean>
  /** 已成功渲染的瓦片数（诊断/监控用） */
  renderedCount = 0
  /** 渲染性能统计（监控/诊断用） */
  stats = { blockCount: 0, totalBlockMs: 0, lastBlockMs: 0, queueDepth: 0, lastBlockZoom: 0, zoomHistogram: {} as Record<string, number>, lastRenderMs: 0, lastCopyMs: 0, lastTileFetchMs: 0 }
  // ImageryLayer 构造时会读取这些默认值（undefined 即用 Cesium 默认）
  defaultAlpha: number | undefined = undefined
  defaultNightAlpha: number | undefined = undefined
  defaultDayAlpha: number | undefined = undefined
  defaultBrightness: number | undefined = undefined
  defaultContrast: number | undefined = undefined
  defaultHue: number | undefined = undefined
  defaultSaturation: number | undefined = undefined
  defaultGamma: number | undefined = undefined
  defaultMinificationFilter: unknown = undefined
  defaultMagnificationFilter: unknown = undefined

  private _map: MapLike | undefined
  private _container: HTMLDivElement | undefined
  private _pending = new Map<string, Array<{ x: number; y: number; level: number; resolve: (c: HTMLCanvasElement) => void; reject: (e: unknown) => void }>>()
  private _inFlight: Array<{ reject: (e: unknown) => void }> = []
  private _draining = false
  private _blockCache = new Map<string, HTMLCanvasElement[]>()
  private _destroyed = false
  private readonly _styleUrl: string | undefined
  private readonly _signal: AbortSignal | undefined
  private readonly _createMap: (container: HTMLElement, style: unknown) => MapLike

  constructor(options: VectorTileImageryOptions) {
    this.tileWidth = this.tileHeight = options.tileSize ?? 256
    this.minimumLevel = options.minimumLevel ?? 0
    this.maximumLevel = options.maximumLevel ?? SAFETY.VECTOR_TILE_MAX_ZOOM
    this.rectangle = this.tilingScheme.rectangle
    this.credit = new Cesium.Credit(options.title || 'Esri', false)
    this._styleUrl = styleUrlForLayer(options)
    this._signal = options.signal
    this._createMap = options.createMap ?? defaultCreateMap
    this.readyPromise = this._init().then(() => {
      if (this._destroyed) return false
      this.ready = true
      return true
    })
  }

  getTileCredits(): Cesium.Credit[] {
    return []
  }

  requestImage(x: number, y: number, level: number, _request?: Cesium.Request): Promise<HTMLCanvasElement> | undefined {
    if (this._destroyed || !this.ready) return undefined
    if (level < this.minimumLevel || level > this.maximumLevel) return undefined
    const key = blockKey(x, y, level)
    const cached = this._blockCache.get(key)
    if (cached) {
      // 命中缓存：直接裁剪返回（先返回 Promise，避免同步阻塞 Cesium 主线程）
      return Promise.resolve().then(() => cropTile(cached, x, y, level, this.tileWidth, this.tileHeight))
    }
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      const arr = this._pending.get(key) ?? []
      arr.push({ x, y, level, resolve, reject })
      this._pending.set(key, arr)
      this._drain()
    })
  }

  destroy(): void {
    this._destroyed = true
    this._teardown()
    // 拒绝所有未决瓦片请求（含正在渲染的），避免 Cesium 对应瓦片永远 pending
    const err = new Error('矢量瓦片 provider 已销毁')
    for (const [, jobs] of this._pending) {
      for (const j of jobs) j.reject(err)
    }
    this._pending.clear()
    for (const j of this._inFlight) j.reject(err)
    this._inFlight = []
  }

  private async _init(): Promise<void> {
    const styleUrl = this._styleUrl
    if (!styleUrl) throw new Error('缺少矢量瓦片样式地址')
    const response = await fetch(styleUrl, { signal: withFetchTimeout(this._signal) })
    if (!response.ok) throw new Error('矢量瓦片样式加载失败：HTTP ' + response.status)
    const raw = (await response.json()) as Record<string, unknown>
    const style = normalizeArcGisStyle(raw, styleUrl)
    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.left = '-10000px'
    container.style.top = '-10000px'
    container.style.width = this.tileWidth * BLOCK + 'px'
    container.style.height = this.tileHeight * BLOCK + 'px'
    container.style.overflow = 'hidden'
    document.body.appendChild(container)
    this._container = container
    const map = this._createMap(container, style)
    this._map = map
    if (this._destroyed) {
      // 初始化期间被销毁（例如移除图层）：立刻清理，避免泄漏隐藏容器
      this._teardown()
      return
    }
    await waitForEvent(map, 'load', 20000, 'MapLibre 样式加载')
    if (this._destroyed) {
      this._teardown()
      return
    }
    // 预热一帧：确保 sprite/glyphs 在对外 ready 前拉取完成，避免首屏瓦片缺字
    await waitForMapRender(map)
  }

  private _teardown(): void {
    try {
      this._map?.remove()
    } catch {
      // ignore
    }
    try {
      this._container?.remove()
    } catch {
      // ignore
    }
    this._map = undefined
    this._container = undefined
  }

  private _drain(): void {
    if (this._draining || this._destroyed) return
    this._draining = true
    const loop = async () => {
      try {
        while (this._pending.size > 0 && !this._destroyed) {
          this.stats.queueDepth = this._pending.size
          const [key, jobs] = this._pending.entries().next().value as [
            string,
            Array<{ x: number; y: number; level: number; resolve: (c: HTMLCanvasElement) => void; reject: (e: unknown) => void }>
          ]
          this._pending.delete(key)
          this._inFlight = jobs
          try {
            const block = await this._renderBlock(jobs[0].x, jobs[0].y, jobs[0].level)
            this._rememberBlock(key, block)
            for (const j of jobs) {
              j.resolve(cropTile(block, j.x, j.y, j.level, this.tileWidth, this.tileHeight))
            }
          } catch (e) {
            for (const j of jobs) j.reject(e)
          } finally {
            if (this._inFlight === jobs) this._inFlight = []
          }
        }
      } finally {
        this._draining = false
        if (this._pending.size > 0 && !this._destroyed) this._drain()
      }
    }
    void loop()
  }

  /** 渲染一个 3x3 块（一帧），返回 9 片 canvas（越界位置为透明片） */
  private async _renderBlock(x: number, y: number, level: number): Promise<HTMLCanvasElement[]> {
    const map = this._map
    if (!map || this._destroyed) throw new Error('矢量瓦片 provider 未就绪')
    const t0 = performance.now()
    const tFetch = performance.now()
    this.stats.lastBlockZoom = level
    this.stats.zoomHistogram[String(level)] = (this.stats.zoomHistogram[String(level)] ?? 0) + 1
    const gx = Math.floor(x / BLOCK) * BLOCK
    const gy = Math.floor(y / BLOCK) * BLOCK
    const { lng, lat } = tileCenterLngLat(gx + BLOCK / 2, gy + BLOCK / 2, level)
    map.jumpTo({ center: [lng, lat], zoom: level })
    this.stats.lastTileFetchMs = performance.now() - tFetch
    const tRender = performance.now()
    await waitForMapRender(map)
    this.stats.lastRenderMs = performance.now() - tRender
    const tCopy = performance.now()
    // 关键：WebGL canvas 每 drawImage 一次 = 一次 GPU readPixels。
    // 先整块快照到 2D canvas（每块仅 1 次读回），再纯 CPU 裁剪 9 片，避免与 Cesium 抢 GPU。
    const src = map.getCanvas()
    const snapshot = document.createElement('canvas')
    snapshot.width = this.tileWidth * BLOCK
    snapshot.height = this.tileHeight * BLOCK
    const sctx = snapshot.getContext('2d')
    if (sctx) sctx.drawImage(src, 0, 0, snapshot.width, snapshot.height)
    const out: HTMLCanvasElement[] = []
    for (let j = 0; j < BLOCK * BLOCK; j++) {
      const lx = j % BLOCK
      const ly = Math.floor(j / BLOCK)
      const canvas = document.createElement('canvas')
      canvas.width = this.tileWidth
      canvas.height = this.tileHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(snapshot, lx * this.tileWidth, ly * this.tileHeight, this.tileWidth, this.tileHeight, 0, 0, this.tileWidth, this.tileHeight)
      }
      out.push(canvas)
    }
    this.stats.lastCopyMs = performance.now() - tCopy
    this.renderedCount += BLOCK * BLOCK
    const dt = performance.now() - t0
    this.stats.blockCount += 1
    this.stats.totalBlockMs += dt
    this.stats.lastBlockMs = dt
    return out
  }

  private _rememberBlock(key: string, block: HTMLCanvasElement[]): void {
    this._blockCache.delete(key)
    this._blockCache.set(key, block)
    if (this._blockCache.size > BLOCK_CACHE_LIMIT) {
      const oldest = this._blockCache.keys().next().value as string
      this._blockCache.delete(oldest)
    }
  }
}
