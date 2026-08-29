import * as Cesium from 'cesium'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre 的 worker 通过 new URL(..., import.meta.url) 动态加载，vite 无法静态解析 → 显式 ?worker&url 打包（内联依赖）并 setWorkerUrl
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { withFetchTimeout } from '../service/http'
import { SAFETY } from '../domain/loadSafety'
import { GPU_TIERS, type GpuTierConfig } from './gpuTiers'

// 批量渲染块尺寸：一帧 MapLibre 渲染 3x3 瓦片，读回次数降为 1/9（避免与 Cesium 抢 GPU 导致每片 1s+ 的读回停顿）
const BLOCK = 3
// MapLibre vector tile 固定按 512 CSS 像素定义世界坐标；Cesium 默认影像瓦片是 256px
const MAPLIBRE_VECTOR_TILE_SIZE = 512

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
export function normalizeArcGISStyle(style: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...style }
  if (typeof out.sprite === 'string') out.sprite = resolveStyleUrl(out.sprite, baseUrl)
  if (typeof out.glyphs === 'string') out.glyphs = resolveStyleUrl(out.glyphs, baseUrl)
  // 无 sprite 资源时移除纯 icon 图层的 icon-image，避免 MapLibre 缺失图片告警/重试风暴
  if (typeof out.sprite !== 'string' && Array.isArray(out.layers)) {
    out.layers = out.layers.map((layer) => {
      if (!layer || typeof layer !== 'object') return layer
      const rec = layer as Record<string, unknown>
      if (rec.type !== 'symbol' || !rec.layout || typeof rec.layout !== 'object') return rec
      const layout = rec.layout as Record<string, unknown>
      const tf = layout['text-field']
      if (layout['icon-image'] && typeof tf !== 'string' && !Array.isArray(tf)) {
        // 无 sprite 时移除纯 icon 图层的 icon-image：MapLibre 校验器对 undefined/null 都会报错，
        // 必须彻底删除该键，让图层回退到"无图标"默认值
        const { 'icon-image': _drop, ...rest } = layout
        return { ...rec, layout: rest }
      }
      return rec
    })
  }
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

/** 仅保留带 text-field 的 symbol 图层，移除填充/线/图标等重度图层 */
function keepTextLayersOnly(
  style: Record<string, unknown>,
  scope: 'all' | 'country-city'
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...style }
  if (!Array.isArray(out.layers)) return out
  const isMajorLabel = (id: string): boolean =>
    // 排除 forest or park（景区/公园）：该类图层多为当地语言名，不是主要地名
    !/forest or park/i.test(id) &&
    /^(Continent|Admin0|Admin1|Admin2|City |Disputed label|Place\/Unclassified)/.test(id)
  const filtered = out.layers.filter((layer) => {
    if (!layer || typeof layer !== 'object') return false
    const rec = layer as Record<string, unknown>
    if (rec.type !== 'symbol' || !rec.layout || typeof rec.layout !== 'object') return false
    const tf = (rec.layout as Record<string, unknown>)['text-field']
    // 语言改写后可能是 coalesce 表达式数组，两种形式都算文字图层
    if (typeof tf !== 'string' && !Array.isArray(tf)) return false
    if (scope === 'country-city') return isMajorLabel(String(rec.id ?? ''))
    return true
  })
  // labelsOnly 模式只渲染文字：去掉 icon-image，避免依赖 sprite 与 icon-only 图层
  out.layers = filtered.map((layer) => {
    if (!layer || typeof layer !== 'object') return layer
    const rec = layer as Record<string, unknown>
    if (rec.type !== 'symbol' || !rec.layout || typeof rec.layout !== 'object') return rec
    const layout = rec.layout as Record<string, unknown>
    if (layout['icon-image'] === undefined) return rec
    const { 'icon-image': _drop, ...rest } = layout
    return { ...rec, layout: rest }
  })
  return out
}

export interface TextScaleRamp {
  /** 起始缩放级（低于此级用 lowScale） */
  lowZoom: number
  /** 终端缩放级（高于此级用 highScale） */
  highZoom: number
  lowScale: number
  highScale: number
}

/** 按缩放级线性插值字号倍数 */
export function textScaleFactorAtZoom(ramp: TextScaleRamp, zoom: number): number {
  if (zoom <= ramp.lowZoom) return ramp.lowScale
  if (zoom >= ramp.highZoom) return ramp.highScale
  const t = (zoom - ramp.lowZoom) / (ramp.highZoom - ramp.lowZoom)
  return ramp.lowScale + (ramp.highScale - ramp.lowScale) * t
}

export interface LabelStyleOverrides {
  /** 字号倍数：数值为全级统一，或指定随缩放级增大的梯度 */
  textScale?: number | TextScaleRamp
  textFont?: string[]
  textColor?: string
  haloColor?: string
  haloWidth?: number
}

/** 把样式覆盖应用到所有文字图层：只改 paint/layout，不动 text-field */
export function applyStyleOverrides(
  style: Record<string, unknown>,
  overrides: LabelStyleOverrides | undefined
): Record<string, unknown> {
  if (!overrides) return style
  const out: Record<string, unknown> = { ...style }
  if (!Array.isArray(out.layers)) return out
  const scale = overrides.textScale
  const ramp = typeof scale === 'object' ? scale : undefined
  const scaleAt = (zoom: number): number =>
    ramp ? textScaleFactorAtZoom(ramp, zoom) : (typeof scale === 'number' ? scale : 1)
  out.layers = out.layers.map((layer) => {
    if (!layer || typeof layer !== 'object' || (layer as Record<string, unknown>).type !== 'symbol') return layer
    const rec = layer as Record<string, unknown>
    const hasText = !!rec.layout && typeof rec.layout === 'object' && (rec.layout as Record<string, unknown>)['text-field']
    if (!hasText) return layer
    const layout = { ...(rec.layout as Record<string, unknown>) }
    const paint = { ...((rec.paint as Record<string, unknown>) ?? {}) }
    if (scale !== undefined) {
      const size = layout['text-size']
      const layerMaxZoom = typeof rec.maxzoom === 'number' ? rec.maxzoom : ramp?.highZoom
      if (typeof size === 'number') {
        layout['text-size'] = size * scaleAt(layerMaxZoom ?? ramp?.highZoom ?? 1)
      } else if (size && typeof size === 'object') {
        const stops = (size as { stops?: unknown }).stops
        if (Array.isArray(stops)) {
          layout['text-size'] = {
            ...(size as Record<string, unknown>),
            stops: stops.map((entry) => {
              if (Array.isArray(entry) && typeof entry[1] === 'number') return [entry[0], entry[1] * scaleAt(entry[0] as number)]
              return entry
            }),
          }
        }
      }
    }
    if (overrides.textFont) layout['text-font'] = overrides.textFont
    if (overrides.textColor) paint['text-color'] = overrides.textColor
    if (overrides.haloColor) paint['text-halo-color'] = overrides.haloColor
    if (overrides.haloWidth !== undefined) paint['text-halo-width'] = overrides.haloWidth
    const next: Record<string, unknown> = { ...rec, layout }
    if (Object.keys(paint).length > 0) next.paint = paint
    return next
  })
  return out
}

/** 地名语言改写：'en' 统一优先英文并回退，'local' 把水系全球名换成当地语言名 */
export function applyLabelLanguage(
  style: Record<string, unknown>,
  language: 'en' | 'local' | undefined
): Record<string, unknown> {
  if (!language) return style
  const out: Record<string, unknown> = { ...style }
  if (!Array.isArray(out.layers)) return out
  out.layers = out.layers.map((layer) => {
    if (!layer || typeof layer !== 'object' || (layer as Record<string, unknown>).type !== 'symbol') return layer
    const rec = layer as Record<string, unknown>
    if (!rec.layout || typeof rec.layout !== 'object') return layer
    const layout = { ...(rec.layout as Record<string, unknown>) }
    const tf = layout['text-field']
    const m = typeof tf === 'string' ? tf.match(/^\{(_name|_name_global|_name_local)\}$/) : undefined
    if (!m) return layer
    if (language === 'local' && m[1] === '_name_global') {
      layout['text-field'] = '{_name_local}'
    } else if (language === 'en') {
      // 仅英文：_name_en 优先，其次 _name_global/_name；
      // 不回退到当地语言（中文景区名由范围过滤排除）
      layout['text-field'] = ['coalesce', ['get', '_name_en'], ['get', '_name_global'], ['get', '_name']]
    }
    return { ...rec, layout }
  })
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

/** NxN 块的几何中心（连续瓦片索引）。内部块 = 中间瓦片；世界边缘块 clamp 到有效范围，避免 wrap 错位 */
export function blockCenterIndex(
  gx: number,
  gy: number,
  z: number,
  block = BLOCK
): { cx: number; cy: number } {
  const n = 2 ** z
  const gx2 = Math.min(gx + block - 1, n - 1)
  const gy2 = Math.min(gy + block - 1, n - 1)
  // 块覆盖 [gx, gx2+1)，几何中心 = (gx + gx2 + 1) / 2
  return { cx: (gx + gx2 + 1) / 2, cy: (gy + gy2 + 1) / 2 }
}

/** 瓦片所属 NxN 块缓存键（块内任意一片命中即整块命中；N 随 GPU 档位变化） */
export function blockKey(x: number, y: number, z: number, block = BLOCK): string {
  return z + '/' + Math.floor(x / block) + '/' + Math.floor(y / block)
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
  tileSize: number,
  block = BLOCK
): { mapZoom: number; sourceScale: number; viewportSize: number } {
  const nativeScale = MAPLIBRE_VECTOR_TILE_SIZE / tileSize
  const zoomOffset = Math.log2(nativeScale)
  const canUseAlignedZoom = nativeScale > 1 && Number.isInteger(zoomOffset) && level > zoomOffset
  if (canUseAlignedZoom) {
    return {
      mapZoom: level - zoomOffset,
      sourceScale: 1,
      viewportSize: tileSize * block,
    }
  }
  return {
    mapZoom: level,
    sourceScale: nativeScale,
    viewportSize: MAPLIBRE_VECTOR_TILE_SIZE * block,
  }
}

/** 从 MapLibre NxN 块快照中裁剪指定 Cesium 瓦片；自定义较小 tileSize 时按 sourceScale 下采样。 */
export function cropTile(
  snapshot: HTMLCanvasElement,
  x: number,
  y: number,
  z: number,
  tileWidth: number,
  tileHeight: number,
  sourceScale = 1,
  renderedCenter?: { cx: number; cy: number },
  block = BLOCK
): HTMLCanvasElement {
  const n = 2 ** z
  const out = document.createElement('canvas')
  out.width = tileWidth
  out.height = tileHeight
  const ctx = out.getContext('2d')
  if (x < 0 || y < 0 || x >= n || y >= n) return out
  const gx = Math.floor(x / block) * block
  const gy = Math.floor(y / block) * block
  const { cx, cy } = renderedCenter ?? blockCenterIndex(gx, gy, z, block)
  // 视口宽 = block 瓦片，中心在 cx → 视口西边界索引 = cx - block/2
  const sourceWidth = tileWidth * sourceScale
  const sourceHeight = tileHeight * sourceScale
  const sx = Math.round((x - (cx - block / 2)) * sourceWidth)
  const sy = Math.round((y - (cy - block / 2)) * sourceHeight)
  if (sx < 0 || sy < 0 || sx + sourceWidth > snapshot.width || sy + sourceHeight > snapshot.height) return out
  if (ctx) ctx.drawImage(snapshot, sx, sy, sourceWidth, sourceHeight, 0, 0, tileWidth, tileHeight)
  return out
}

/** 从已裁剪的 NxN 块缓存取回指定瓦片；边缘块和越界位置返回透明片。 */
function tileFromBlock(
  canvases: HTMLCanvasElement[],
  x: number,
  y: number,
  z: number,
  tileWidth: number,
  tileHeight: number,
  block = BLOCK
): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = tileWidth
  out.height = tileHeight
  const n = 2 ** z
  if (x < 0 || y < 0 || x >= n || y >= n) return out
  const gx = Math.floor(x / block) * block
  const gy = Math.floor(y / block) * block
  return canvases[(y - gy) * block + (x - gx)] ?? out
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
  /** 地名语言：'en' 优先英文，'local' 用当地语言 */
  language?: 'en' | 'local'
  /** 仅保留文字图层（丢掉填充/线等重度图层，大幅加快基底标注渲染） */
  labelsOnly?: boolean
  /** 标注范围：'country-city' 仅保留大陆/国家/州省/城市等主要地名层 */
  labelScope?: 'all' | 'country-city'
  /** 并行 MapLibre 实例数（默认 3） */
  mapPoolSize?: number
  /** GPU 预算档位（缺省 high）：决定画布尺寸/并发实例数/缓存上限 */
  gpuTier?: GpuTierConfig
  /** 任一 MapLibre WebGL 上下文丢失时回调（上报给 GpuMemoryManager 触发降档重建） */
  onContextLost?: () => void
  /** 离屏渲染许可：false 时跳过渲染并返回空瓦片（critical 档相机静止时使用） */
  canRenderNow?: () => boolean
  /** 字体/颜色等样式覆盖（用于对齐 Map Viewer 的标注字体观感） */
  styleOverrides?: LabelStyleOverrides
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
 * requestImage 走并行 MapLibre 实例池（默认 3 个，每实例严格串行），默认返回原生 512px canvas。
 * 只实现 ImageryProvider 协议字段，交给 Cesium.ImageryLayer 消费（鸭子类型，不继承基类）。
 */
export class ArcGISVectorTileImageryProvider {
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

  private _maps: MapLike[] = []
  private _containers: HTMLDivElement[] = []
  private _mapViewportSizes: number[] = []
  private _pending = new Map<string, Array<{ x: number; y: number; level: number; resolve: (c: HTMLCanvasElement) => void; reject: (e: unknown) => void }>>()
  private _inFlight: Array<{ reject: (e: unknown) => void }> = []
  private _active = 0
  /** 每个 Map 实例当前是否在渲染块：并发派发时只选空闲实例，保证同一 canvas 严格串行 */
  private _mapActiveCount: number[] = []
  private _blockCache = new Map<string, HTMLCanvasElement[]>()
  private _destroyed = false
  private readonly _styleUrl: string | undefined
  private readonly _signal: AbortSignal | undefined
  private readonly _createMap: (container: HTMLElement, style: unknown, pixelRatio: number) => MapLike
  private readonly _language: 'en' | 'local' | undefined
  private readonly _labelsOnly: boolean
  private readonly _labelScope: 'all' | 'country-city'
  private readonly _styleOverrides: LabelStyleOverrides | undefined
  private readonly _mapPixelRatio: number
  private readonly _poolSize: number
  private readonly _blockSize: number
  private readonly _cacheLimit: number
  private readonly _onContextLost: (() => void) | undefined
  private readonly _canRenderNow: (() => boolean) | undefined
  /** 每个 Map 实例的 WebGL 上下文是否存活（丢失后置 false） */
  private _mapAlive: boolean[] = []
  private _mapViewportSize = 0

  constructor(options: VectorTileImageryOptions) {
    // ArcGIS VectorTileServer 与 MapLibre 均以 512px 瓦片为原生单位。
    // 直接交给 Cesium 可让其用 tileWidth 参与 LOD 选择，避免 256px 下采样造成层级补偿漂移。
    this._language = options.language
    this._labelsOnly = options.labelsOnly ?? false
    this._labelScope = options.labelScope ?? 'all'
    const tier = options.gpuTier ?? GPU_TIERS.high
    this._poolSize = Math.max(1, Math.min(4, options.mapPoolSize ?? tier.poolSize))
    this._blockSize = tier.blockSize
    this._cacheLimit = tier.cacheBlocks
    this._onContextLost = options.onContextLost
    this._canRenderNow = options.canRenderNow
    this._styleOverrides = options.styleOverrides
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
    const key = blockKey(x, y, level, this._blockSize)
    const cached = this._blockCache.get(key)
    if (cached) {
      // 命中缓存：直接返回预裁剪瓦片（先返回 Promise，避免同步阻塞 Cesium 主线程）
      return Promise.resolve().then(() => tileFromBlock(cached, x, y, level, this.tileWidth, this.tileHeight, this._blockSize))
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
    const style = applyStyleOverrides(applyLabelLanguage(normalizeArcGISStyle(raw, styleUrl), this._language), this._styleOverrides)
    const finalStyle = this._labelsOnly ? keepTextLayersOnly(style, this._labelScope) : style
    this._mapViewportSize = mapLibreRenderPlan(this.minimumLevel, this.tileWidth, this._blockSize).viewportSize
    for (let i = 0; i < this._poolSize; i += 1) {
      const container = document.createElement('div')
      container.style.position = 'absolute'
      container.style.left = '-10000px'
      container.style.top = '-10000px'
      // 最低层级使用原生 512px 世界；后续渲染会按实际 Cesium LOD 动态调整为对齐视口。
      container.style.width = this._mapViewportSize + 'px'
      container.style.height = this._mapViewportSize + 'px'
      container.style.overflow = 'hidden'
      document.body.appendChild(container)
      const map = this._createMap(container, finalStyle, this._mapPixelRatio)
      // 上报上下文丢失：MapLibre 离屏上下文与主场景独立，GPU 内存耗尽时同样会丢失
      const canvas = map.getCanvas?.()
      if (canvas) {
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          this._mapAlive[i] = false
          this._onContextLost?.()
        })
        canvas.addEventListener('webglcontextrestored', () => {
          this._mapAlive[i] = true
          // 清空块缓存：丢失期间可能缓存过空白瓦片，恢复后必须重渲染而非命中空白
          this._blockCache.clear()
          // 唤醒丢失期间积压的未决请求（相机未移动时 Cesium 不会重新 requestImage）
          this._drain()
        })
      } else {
        console.warn('[globe] MapLibre 未暴露 getCanvas，WebGL 上下文丢失检测不可用')
      }
      this._maps.push(map)
      this._containers.push(container)
      this._mapViewportSizes.push(this._mapViewportSize)
      this._mapAlive.push(true)
    }
    if (this._destroyed) {
      // 初始化期间被销毁（例如移除图层）：立刻清理，避免泄漏隐藏容器
      this._teardown()
      return
    }
    await Promise.all(this._maps.map((m) => waitForEvent(m, 'load', 20000, 'MapLibre 样式加载')))
    if (this._destroyed) {
      this._teardown()
      return
    }
    // 等待首屏稳定：确保 sprite/glyphs 在对外 ready 前拉取完成，避免首屏瓦片缺字
    await Promise.all(this._maps.map((m) => waitForMapIdle(m)))
  }

  private _teardown(): void {
    for (const m of this._maps) {
      try {
        m.remove()
      } catch {
        // ignore
      }
    }
    for (const c of this._containers) {
      try {
        c.remove()
      } catch {
        // ignore
      }
    }
    this._maps = []
    this._containers = []
    this._mapViewportSizes = []
  }

  private _drain(): void {
    if (this._destroyed) return
    // 极限档：相机静止时暂停离屏渲染，避免与主场景持续抢 GPU
    if (this._canRenderNow && !this._canRenderNow()) return
    // 并发派发：有空闲 MapLibre 实例就接下一个块，直到队列清空
    while (this._pending.size > 0 && this._active < this._poolSize) {
      this.stats.queueDepth = this._pending.size
      // 优先渲染更精细的块：低空观察时深层城市名先出现，避免久停在粗级别标注
      let bestKey: string | undefined
      let bestLevel = -1
      for (const [k, jobs] of this._pending) {
        const lv = jobs[0]?.level ?? -1
        if (lv > bestLevel) {
          bestLevel = lv
          bestKey = k
        }
      }
      if (bestKey === undefined) break
      const jobs = this._pending.get(bestKey) as Array<{ x: number; y: number; level: number; resolve: (c: HTMLCanvasElement) => void; reject: (e: unknown) => void }>
      // 只选当前空闲的 Map：轮询复用（0,1,2,0…）会在先完成的任务释放前把新块派到
      // 仍在渲染的实例上，同一 canvas 被并发 jumpTo/快照 → 读到别的块的帧，标注整体错位 ~90°
      let mapIndex = -1
      for (let i = 0; i < this._poolSize; i += 1) {
        if ((this._mapActiveCount[i] ?? 0) === 0) {
          mapIndex = i
          break
        }
      }
      if (mapIndex < 0) break
      this._pending.delete(bestKey)
      this._active += 1
      for (const j of jobs) this._inFlight.push(j)
      this._mapActiveCount[mapIndex] = 1
      this._renderBlock(mapIndex, jobs[0].x, jobs[0].y, jobs[0].level)
        .then((block) => {
          this._rememberBlock(bestKey, block)
          for (const j of jobs) {
            j.resolve(tileFromBlock(block, j.x, j.y, j.level, this.tileWidth, this.tileHeight, this._blockSize))
          }
        })
        .catch((e) => {
          // 上下文丢失时用空白瓦片兜底（不抛错避免 Cesium 无限重试），等待上层降档重建
          const dead = mapIndex < this._mapAlive.length && !this._mapAlive[mapIndex]
          const lost = dead || /context lost|webgl/i.test(String((e as Error)?.message ?? e))
          if (lost) {
            const blank = this._blankBlock()
            this._rememberBlock(bestKey, blank)
            for (const j of jobs) {
              j.resolve(tileFromBlock(blank, j.x, j.y, j.level, this.tileWidth, this.tileHeight, this._blockSize))
            }
          } else {
            for (const j of jobs) j.reject(e)
          }
        })
        .finally(() => {
          this._active -= 1
          this._mapActiveCount[mapIndex] = 0
          for (const j of jobs) {
            const idx = this._inFlight.indexOf(j)
            if (idx >= 0) this._inFlight.splice(idx, 1)
          }
          if (this._pending.size > 0 && !this._destroyed) this._drain()
        })
    }
  }

  /** 渲染一个 3x3 块（一帧），返回九张 Cesium 瓦片；仅最低层级需要下采样。 */
  private async _renderBlock(mapIndex: number, x: number, y: number, level: number): Promise<HTMLCanvasElement[]> {
    const map = this._maps[mapIndex]
    if (!map || this._destroyed) throw new Error('矢量瓦片 provider 未就绪')
    if (mapIndex < this._mapAlive.length && !this._mapAlive[mapIndex]) {
      throw new Error('MapLibre WebGL 上下文已丢失')
    }
    const t0 = performance.now()
    const tFetch = performance.now()
    const plan = mapLibreRenderPlan(level, this.tileWidth, this._blockSize)
    this.stats.lastBlockZoom = plan.mapZoom
    this.stats.zoomHistogram[String(plan.mapZoom)] = (this.stats.zoomHistogram[String(plan.mapZoom)] ?? 0) + 1
    this._setMapViewport(mapIndex, plan.viewportSize)
    const gx = Math.floor(x / this._blockSize) * this._blockSize
    const gy = Math.floor(y / this._blockSize) * this._blockSize
    // 块几何中心（内部块=中间瓦片中心；边缘块 clamp，避免 wrap 错位）
    const { cx, cy } = blockCenterIndex(gx, gy, level, this._blockSize)
    // renderWorldCopies=false 时，视口超出世界范围的边缘块会被 MapLibre 钳制中心；
    // 我们自己先在 x/y 两个方向钳制，并按钳制后的中心计算裁剪，避免依赖 MapLibre 的不可预测收拢。
    const n = 2 ** level
    const half = this._blockSize / 2
    const clampedCx = Math.min(n - half, Math.max(half, cx))
    const clampedCy = Math.min(n - half, Math.max(half, cy))
    const expectedCenter = { cx: clampedCx, cy: clampedCy }
    const { lng, lat } = indexToLngLat(clampedCx, clampedCy, level)
    map.jumpTo({ center: [lng, lat], zoom: plan.mapZoom })
    // 用 getCenter 校验；若返回的中心与预期偏差超过半瓦片（如并发时取到旧中心），直接采用预期中心
    const actualCenter = map.getCenter?.()
    const actualIdx = actualCenter ? lngLatToIndex(actualCenter.lng, actualCenter.lat, level) : expectedCenter
    const renderedCenter =
      Math.abs(actualIdx.cx - expectedCenter.cx) < 0.5 && Math.abs(actualIdx.cy - expectedCenter.cy) < 0.5
        ? actualIdx
        : expectedCenter
    this.stats.lastTileFetchMs = performance.now() - tFetch
    const tRender = performance.now()
    await waitForMapIdle(map)
    // 硬件 GPU 下 WebGL canvas 的读回可能滞后一帧（读到上一个块的内容），
    // 等两次 rAF 确保合成器已展示当前帧再截取，避免标注置位。
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
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
    for (let ly = 0; ly < this._blockSize; ly += 1) {
      for (let lx = 0; lx < this._blockSize; lx += 1) {
        block.push(cropTile(snapshot, gx + lx, gy + ly, level, this.tileWidth, this.tileHeight, plan.sourceScale, renderedCenter, this._blockSize))
      }
    }
    // 临时快照不进入 LRU 缓存，释放其像素缓冲；缓存只保留九张最终输出瓦片。
    snapshot.width = 0
    snapshot.height = 0
    this.stats.lastCopyMs = performance.now() - tCopy
    this.renderedCount += this._blockSize ** 2
    const dt = performance.now() - t0
    this.stats.blockCount += 1
    this.stats.totalBlockMs += dt
    this.stats.lastBlockMs = dt
    return block
  }

  private _setMapViewport(mapIndex: number, size: number): void {
    if (this._mapViewportSizes[mapIndex] === size) return
    const container = this._containers[mapIndex]
    if (!container) return
    container.style.width = size + 'px'
    container.style.height = size + 'px'
    this._mapViewportSizes[mapIndex] = size
    this._maps[mapIndex]?.resize?.()
  }

  private _rememberBlock(key: string, block: HTMLCanvasElement[]): void {
    this._blockCache.delete(key)
    this._blockCache.set(key, block)
    if (this._blockCache.size > this._cacheLimit) {
      const oldest = this._blockCache.keys().next().value as string
      this._blockCache.delete(oldest)
    }
  }

  /** 返回一块空白瓦片（上下文丢失/离屏暂停时兜底，避免 Cesium 无限重试）。 */
  private _blankBlock(): HTMLCanvasElement[] {
    const out: HTMLCanvasElement[] = []
    for (let i = 0; i < this._blockSize ** 2; i += 1) {
      const c = document.createElement('canvas')
      c.width = this.tileWidth
      c.height = this.tileHeight
      out.push(c)
    }
    return out
  }
}
