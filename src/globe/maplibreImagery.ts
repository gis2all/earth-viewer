import * as Cesium from 'cesium'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre 的 worker 通过 new URL(..., import.meta.url) 动态加载，vite 无法静态解析 → 显式 ?worker&url 打包（内联依赖）并 setWorkerUrl
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { withFetchTimeout } from './webmap'
import { SAFETY } from './loadSafety'

// 批量渲染块尺寸：一帧 MapLibre 渲染 3x3 瓦片，读回次数降为 1/9（避免与 Cesium 抢 GPU 导致每片 1s+ 的读回停顿）
const BLOCK = 3
// MapLibre vector tile 固定按 512 CSS 像素定义世界坐标；Cesium 默认影像瓦片是 256px
const MAPLIBRE_VECTOR_TILE_SIZE = 512
// 512px 原生输出时每块像素数是旧 256px 输出的四倍，保留 12 块可维持约 108MB 的像素预算。
const BLOCK_CACHE_LIMIT = 12

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
  tileSize?: number
  [key: string]: unknown
}

/**
 * 规范化 ArcGIS root.json 为 MapLibre 可用样式：
 * - sprite / glyphs 相对路径 → 相对样式地址解析为绝对 URL
 * - vector source 的 url 指向 VectorTileServer → 改写成 {z}/{y}/{x}.pbf tiles 模板
 *   （MapLibre 的 url 字段期望是 TileJSON 端点，VectorTileServer 不是；已有 tiles 的保留并解析相对模板）
 * - 移除 vector source 的 tileSize：该字段只适用于 raster source，写入会导致 MapLibre 样式校验失败
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
      delete s.tileSize
      if (Array.isArray(s.tiles) && s.tiles.length > 0) {
        s.tiles = s.tiles.map((t) => resolveStyleUrl(t, baseUrl))
        delete s.url
      } else if (typeof s.url === 'string' && s.url.length > 0) {
        const resolvedUrl = resolveStyleUrl(s.url, baseUrl)
        if (/\/VectorTileServer\/?$/i.test(resolvedUrl)) {
          s.tiles = [resolvedUrl.replace(/\/?$/, '') + '/tile/{z}/{y}/{x}.pbf']
          delete s.url
        } else {
          s.url = resolvedUrl
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

/** 连续瓦片索引空间 → 经纬度（px=0.5 即瓦片 0 中心；Cesium 与 MapLibre 的 y 都从北向南） */
export function indexToLngLat(px: number, py: number, z: number): { lng: number; lat: number } {
  const n = 2 ** z
  const lng = (px / n) * 360 - 180
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * (180 / Math.PI)
  return { lng, lat }
}

/** 经/纬度 → 连续 WebMercator 瓦片索引（与 indexToLngLat 互逆）。 */
function lngLatToIndex(lng: number, lat: number, z: number): { cx: number; cy: number } {
  const n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  return {
    cx: ((lng + 180) / 360) * n,
    cy: ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n,
  }
}

/** WebMercator 瓦片中心经纬度（Cesium WebMercatorTilingScheme 与 MapLibre 的 y 都从北向南，可直接用） */
export function tileCenterLngLat(x: number, y: number, z: number): { lng: number; lat: number } {
  return indexToLngLat(x + 0.5, y + 0.5, z)
}

/** 3x3 块的几何中心（连续瓦片索引）。内部块 = 中间瓦片 (gx+1, gy+1)；世界边缘块 clamp 到有效范围，避免 wrap 错位 */
export function blockCenterIndex(gx: number, gy: number, z: number): { cx: number; cy: number } {
  const n = 2 ** z
  const gx2 = Math.min(gx + BLOCK - 1, n - 1)
  const gy2 = Math.min(gy + BLOCK - 1, n - 1)
  // 块覆盖 [gx, gx2+1)，几何中心 = (gx + gx2 + 1) / 2（内部块 = 中间瓦片中心 gx+1.5）
  return { cx: (gx + gx2 + 1) / 2, cy: (gy + gy2 + 1) / 2 }
}

/** 瓦片所属 3x3 块缓存键（块内任意一片命中即整块命中） */
export function blockKey(x: number, y: number, z: number): string {
  return z + '/' + Math.floor(x / BLOCK) + '/' + Math.floor(y / BLOCK)
}

/**
 * 对齐 Cesium 影像瓦片与 MapLibre 的世界像素尺度。
 *
 * 默认 provider 原生输出 512px，因此 Cesium 和 MapLibre 始终使用相同层级。
 * `tileSize` 被调用方显式设为更小的 2 的幂时，才补偿 MapLibre zoom，保持
 * 样式表达式、符号碰撞与实际显示的地面像素比例一致。
 */
export function mapLibreRenderPlan(
  level: number,
  tileSize: number
): { mapZoom: number; sourceScale: number; viewportSize: number } {
  const nativeScale = MAPLIBRE_VECTOR_TILE_SIZE / tileSize
  const zoomOffset = Math.log2(nativeScale)
  const canUseAlignedZoom = nativeScale > 1 && Number.isInteger(zoomOffset) && level > zoomOffset
  if (canUseAlignedZoom) {
    return {
      mapZoom: level - zoomOffset,
      sourceScale: 1,
      viewportSize: tileSize * BLOCK,
    }
  }
  return {
    mapZoom: level,
    sourceScale: nativeScale,
    viewportSize: MAPLIBRE_VECTOR_TILE_SIZE * BLOCK,
  }
}

/** 从 MapLibre 3x3 块快照中裁剪指定 Cesium 瓦片；自定义较小 tileSize 时按 sourceScale 下采样。 */
export function cropTile(
  snapshot: HTMLCanvasElement,
  x: number,
  y: number,
  z: number,
  tileWidth: number,
  tileHeight: number,
  sourceScale = 1,
  renderedCenter?: { cx: number; cy: number }
): HTMLCanvasElement {
  const n = 2 ** z
  const out = document.createElement('canvas')
  out.width = tileWidth
  out.height = tileHeight
  const ctx = out.getContext('2d')
  if (x < 0 || y < 0 || x >= n || y >= n) return out
  const gx = Math.floor(x / BLOCK) * BLOCK
  const gy = Math.floor(y / BLOCK) * BLOCK
  const { cx, cy } = renderedCenter ?? blockCenterIndex(gx, gy, z)
  // 视口宽 = BLOCK 瓦片，中心在 cx → 视口西边界索引 = cx - BLOCK/2
  const sourceWidth = tileWidth * sourceScale
  const sourceHeight = tileHeight * sourceScale
  const sx = Math.round((x - (cx - BLOCK / 2)) * sourceWidth)
  const sy = Math.round((y - (cy - BLOCK / 2)) * sourceHeight)
  if (sx < 0 || sy < 0 || sx + sourceWidth > snapshot.width || sy + sourceHeight > snapshot.height) return out
  if (ctx) ctx.drawImage(snapshot, sx, sy, sourceWidth, sourceHeight, 0, 0, tileWidth, tileHeight)
  return out
}

/** 从已裁剪的 3x3 块缓存取回指定瓦片；边缘块和越界位置返回透明片。 */
function tileFromBlock(
  block: HTMLCanvasElement[],
  x: number,
  y: number,
  z: number,
  tileWidth: number,
  tileHeight: number
): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = tileWidth
  out.height = tileHeight
  const n = 2 ** z
  if (x < 0 || y < 0 || x >= n || y >= n) return out
  const gx = Math.floor(x / BLOCK) * BLOCK
  const gy = Math.floor(y / BLOCK) * BLOCK
  return block[(y - gy) * BLOCK + (x - gx)] ?? out
}

/** MapLibre Map 的测试友好最小接口 */
export interface MapLike {
  once(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  triggerRepaint(): void
  resize?(): unknown
  jumpTo(options: { center: [number, number]; zoom: number }): unknown
  getCenter?(): { lng: number; lat: number }
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
  createMap?: (container: HTMLElement, style: unknown, pixelRatio: number) => MapLike
}

/** 默认 Map 构造：真实 MapLibre GL 离屏渲染（隐藏容器 + preserveDrawingBuffer 读像素） */
function defaultCreateMap(container: HTMLElement, style: unknown, pixelRatio: number): MapLike {
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
    // MapLibre vector world 固定每瓦片 512 CSS px；保持原生画布比例，随后一次性裁剪并下采样为 Cesium 瓦片
    pixelRatio,
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

/** 触发重绘并等待 idle：只有当前可见瓦片、字体和 sprite 都稳定后才允许截屏。 */
function waitForMapIdle(map: MapLike, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('MapLibre 瓦片稳定超时'))
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
    map.off('idle', onRender)
      map.off('error', onError)
      window.clearTimeout(timer)
    }
    map.once('idle', onRender)
    map.once('error', onError)
    map.triggerRepaint()
  })
}

/**
 * 用 MapLibre 按 ArcGIS 官方样式渲染矢量瓦片的 Cesium ImageryProvider。
 * requestImage 串行渲染（共享一个隐藏 Map，避免相机竞态），默认返回原生 512px canvas。
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
  private readonly _createMap: (container: HTMLElement, style: unknown, pixelRatio: number) => MapLike
  private readonly _mapPixelRatio: number
  private _mapViewportSize = 0

  constructor(options: VectorTileImageryOptions) {
    // ArcGIS VectorTileServer 与 MapLibre 均以 512px 瓦片为原生单位。
    // 直接交给 Cesium 可让其用 tileWidth 参与 LOD 选择，避免 256px 下采样造成层级补偿漂移。
    this.tileWidth = this.tileHeight = options.tileSize ?? MAPLIBRE_VECTOR_TILE_SIZE
    this.minimumLevel = options.minimumLevel ?? 0
    this.maximumLevel = options.maximumLevel ?? SAFETY.VECTOR_TILE_MAX_ZOOM
    this.rectangle = this.tilingScheme.rectangle
    this.credit = new Cesium.Credit(options.title || 'Esri', false)
    this._styleUrl = styleUrlForLayer(options)
    this._signal = options.signal
    this._createMap = options.createMap ?? defaultCreateMap
    this._mapPixelRatio = 1
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
      // 命中缓存：直接返回预裁剪瓦片（先返回 Promise，避免同步阻塞 Cesium 主线程）
      return Promise.resolve().then(() => tileFromBlock(cached, x, y, level, this.tileWidth, this.tileHeight))
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
    // 最低层级使用原生 512px 世界；后续渲染会按实际 Cesium LOD 动态调整为对齐视口。
    this._mapViewportSize = mapLibreRenderPlan(this.minimumLevel, this.tileWidth).viewportSize
    container.style.width = this._mapViewportSize + 'px'
    container.style.height = this._mapViewportSize + 'px'
    container.style.overflow = 'hidden'
    document.body.appendChild(container)
    this._container = container
    const map = this._createMap(container, style, this._mapPixelRatio)
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
    // 等待首屏稳定：确保 sprite/glyphs 在对外 ready 前拉取完成，避免首屏瓦片缺字
    await waitForMapIdle(map)
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
              j.resolve(tileFromBlock(block, j.x, j.y, j.level, this.tileWidth, this.tileHeight))
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

  /** 渲染一个 3x3 块（一帧），返回九张 Cesium 瓦片；仅最低层级需要下采样。 */
  private async _renderBlock(x: number, y: number, level: number): Promise<HTMLCanvasElement[]> {
    const map = this._map
    if (!map || this._destroyed) throw new Error('矢量瓦片 provider 未就绪')
    const t0 = performance.now()
    const tFetch = performance.now()
    const plan = mapLibreRenderPlan(level, this.tileWidth)
    this.stats.lastBlockZoom = plan.mapZoom
    this.stats.zoomHistogram[String(plan.mapZoom)] = (this.stats.zoomHistogram[String(plan.mapZoom)] ?? 0) + 1
    this._setMapViewport(plan.viewportSize)
    const gx = Math.floor(x / BLOCK) * BLOCK
    const gy = Math.floor(y / BLOCK) * BLOCK
    // 块几何中心（内部块=中间瓦片中心；边缘块 clamp，避免 wrap 错位）
    const { cx, cy } = blockCenterIndex(gx, gy, level)
    const { lng, lat } = indexToLngLat(cx, cy, level)
    map.jumpTo({ center: [lng, lat], zoom: plan.mapZoom })
    // renderWorldCopies=false 时，MapLibre 会把接近世界边缘的中心收拢。
    // 裁剪必须使用收拢后的实际中心，否则会错取相邻瓦片并产生巨大位置偏移。
    const actualCenter = map.getCenter?.()
    const renderedCenter = actualCenter ? lngLatToIndex(actualCenter.lng, actualCenter.lat, level) : { cx, cy }
    this.stats.lastTileFetchMs = performance.now() - tFetch
    const tRender = performance.now()
    await waitForMapIdle(map)
    this.stats.lastRenderMs = performance.now() - tRender
    const tCopy = performance.now()
    // 关键：WebGL canvas 每 drawImage 一次 = 一次 GPU readPixels。
    // 先整块快照到 2D canvas（每块仅 1 次读回），再纯 2D Canvas 裁剪（必要时下采样）9 片，避免与 Cesium 抢 GPU。
    const src = map.getCanvas()
    const snapshot = document.createElement('canvas')
    snapshot.width = plan.viewportSize
    snapshot.height = plan.viewportSize
    const sctx = snapshot.getContext('2d')
    if (sctx) sctx.drawImage(src, 0, 0, snapshot.width, snapshot.height)
    const block: HTMLCanvasElement[] = []
    for (let ly = 0; ly < BLOCK; ly += 1) {
      for (let lx = 0; lx < BLOCK; lx += 1) {
        block.push(cropTile(snapshot, gx + lx, gy + ly, level, this.tileWidth, this.tileHeight, plan.sourceScale, renderedCenter))
      }
    }
    // 临时快照不进入 LRU 缓存，释放其像素缓冲；缓存只保留九张最终输出瓦片。
    snapshot.width = 0
    snapshot.height = 0
    this.stats.lastCopyMs = performance.now() - tCopy
    this.renderedCount += BLOCK * BLOCK
    const dt = performance.now() - t0
    this.stats.blockCount += 1
    this.stats.totalBlockMs += dt
    this.stats.lastBlockMs = dt
    return block
  }

  private _setMapViewport(size: number): void {
    if (this._mapViewportSize === size) return
    const container = this._container
    if (!container) return
    container.style.width = size + 'px'
    container.style.height = size + 'px'
    this._mapViewportSize = size
    this._map?.resize?.()
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
