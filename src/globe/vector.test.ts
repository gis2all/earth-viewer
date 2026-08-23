import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  reprojectCoordinates,
  reprojectFeatureCollection,
  crsWkidFromGeoJson,
  detectServiceWkid,
} from './vector'

describe('reprojectCoordinates', () => {
  it('点 [x,y] 重投影为 [lon,lat]', () => {
    const out = reprojectCoordinates([20037508.342789244, 20037508.342789244] as number[], 'EPSG:3857', 'EPSG:4326')
    expect(Array.isArray(out)).toBe(true)
    const a = out as number[]
    expect(a[0]).toBeCloseTo(180, 3)
    expect(a[1]).toBeCloseTo(85.051, 3)
  })
  it('嵌套 polygon 坐标结构保留，叶子被转换', () => {
    const poly = [[[0, 0], [1, 1]], [[0, 1], [1, 0]]]
    const out = reprojectCoordinates(poly as unknown as number[], 'EPSG:3857', 'EPSG:4326') as unknown[]
    expect(Array.isArray(out)).toBe(true)
    expect(Array.isArray((out[0] as unknown[])[0])).toBe(true)
  })
})

describe('crsWkidFromGeoJson', () => {
  it('从 urn:ogc:def:crs:EPSG::4326 读取 wkid', () => {
    expect(crsWkidFromGeoJson({ crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } } })).toBe(3857)
    expect(crsWkidFromGeoJson({ crs: { properties: { name: 'EPSG::4326' } } })).toBe(4326)
  })
  it('无 crs / 无名称 → undefined', () => {
    expect(crsWkidFromGeoJson({})).toBeUndefined()
    expect(crsWkidFromGeoJson({ crs: { properties: {} } })).toBeUndefined()
  })
})

describe('reprojectFeatureCollection', () => {
  it('wkid=3857 时重投影几何坐标为经纬度', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [0, 0] } }] }
    const out = reprojectFeatureCollection(fc, 3857)
    expect((out.features as { geometry: { coordinates: number[] } }[])[0].geometry.coordinates[0]).toBeCloseTo(0, 5)
  })
  it('wkid=4326 原样返回', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [100, 30] } }] }
    expect(reprojectFeatureCollection(fc, 4326)).toBe(fc)
  })
  it('未知 wkid（proj4 未定义）原样返回', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [100, 30] } }] }
    expect(reprojectFeatureCollection(fc, 999999)).toBe(fc)
  })
  it('无 wkid 且无 crs 属性 → 原样返回', () => {
    const fc = { type: 'FeatureCollection', features: [] }
    expect(reprojectFeatureCollection(fc)).toBe(fc)
  })
})

describe('detectServiceWkid', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('读取 spatialReference.wkid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 102100 } }) })))
    expect(await detectServiceWkid('https://sv1/FeatureServer/0')).toBe(102100)
  })
  it('meta 非 ok → undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await detectServiceWkid('https://sv2/FeatureServer/0')).toBeUndefined()
  })
})


import { rendererToStyleFn } from './vector'

describe('rendererToStyleFn', () => {
  it('simple: 固定样式', () => {
    const fn = rendererToStyleFn({ type: 'simple', symbol: { type: 'esriSFS', color: [255, 0, 0, 255], outline: { color: [0, 0, 0, 255], width: 2 } } })
    const st = fn({})
    expect(st?.fill).toEqual([255, 0, 0, 255])
    expect(st?.stroke).toEqual([0, 0, 0, 255])
    expect(st?.strokeWidth).toBe(2)
  })
  it('simple: no symbol -> undefined', () => {
    expect(rendererToStyleFn({ type: 'simple', symbol: undefined })({})).toBeUndefined()
  })
  it('uniqueValue: 按字段分类取值', () => {
    const fn = rendererToStyleFn({
      type: 'uniqueValue', field1: 'CAT',
      uniqueValueInfos: [
        { value: 'A', symbol: { type: 'esriSMS', color: [0, 255, 0, 255], size: 6 } },
        { value: 'B', symbol: { type: 'esriSMS', color: [0, 0, 255, 255], size: 9 } },
      ],
    })
    expect(fn({ CAT: 'A' })?.markerColor).toEqual([0, 255, 0, 255])
    expect(fn({ CAT: 'B' })?.markerSize).toBe(9)
    expect(fn({ CAT: 'C' })).toBeUndefined()
  })
  it('classBreaks: 数值落在分类区间', () => {
    const fn = rendererToStyleFn({
      type: 'classBreaks', field: 'POP',
      classBreakInfos: [
        { classMaxValue: 100, symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } },
        { classMaxValue: 1000, symbol: { type: 'esriSFS', color: [4, 5, 6, 255] } },
      ],
    })
    expect(fn({ POP: 50 })?.fill).toEqual([1, 2, 3, 255])
    expect(fn({ POP: 500 })?.fill).toEqual([4, 5, 6, 255])
    expect(fn({ POP: 'x' })).toBeUndefined()
  })
  it('unsupported -> undefined', () => {
    expect(rendererToStyleFn({ type: 'heatmap' })({})).toBeUndefined()
    expect(rendererToStyleFn(undefined)({})).toBeUndefined()
  })
})


import { applyFeatureStyler } from './vector'

describe('applyFeatureStyler', () => {
  function colorClose(c: { red: number; green: number; blue: number } | undefined, r: number, g: number, b: number) {
    expect(c).toBeTruthy()
    expect(c!.red).toBeCloseTo(r / 255, 3)
    expect(c!.green).toBeCloseTo(g / 255, 3)
    expect(c!.blue).toBeCloseTo(b / 255, 3)
  }

  it('classBreaks: 应用面填充/描边', () => {
    const ds = { entities: { values: [{ properties: { POP: 500 }, polygon: {} }] } }
    const fn = rendererToStyleFn({
      type: 'classBreaks', field: 'POP',
      classBreakInfos: [
        { classMaxValue: 100, symbol: { type: 'esriSFS', color: [1, 2, 3, 255], outline: { color: [9, 9, 9, 255], width: 2 } } },
        { classMaxValue: 1000, symbol: { type: 'esriSFS', color: [4, 5, 6, 255], outline: { color: [8, 8, 8, 255], width: 3 } } },
      ],
    })
    applyFeatureStyler(ds as never, fn)
    const poly = (ds.entities.values[0] as any).polygon
    colorClose(poly.material, 4, 5, 6)
    colorClose(poly.outlineColor, 8, 8, 8)
    expect(poly.outlineWidth).toBe(3)
  })

  it('uniqueValue: 应用点颜色/尺寸', () => {
    const ds = { entities: { values: [{ properties: { CAT: 'B' }, point: {} }] } }
    const fn = rendererToStyleFn({
      type: 'uniqueValue', field1: 'CAT',
      uniqueValueInfos: [
        { value: 'A', symbol: { type: 'esriSMS', color: [0, 255, 0, 255], size: 6 } },
        { value: 'B', symbol: { type: 'esriSMS', color: [0, 0, 255, 255], size: 9 } },
      ],
    })
    applyFeatureStyler(ds as never, fn)
    const point = (ds.entities.values[0] as any).point
    colorClose(point.color, 0, 0, 255)
    expect(point.pixelSize).toBe(9)
  })

  it('polyline stroke 应用', () => {
    const ds = { entities: { values: [{ properties: {}, polyline: {} }] } }
    const fn = rendererToStyleFn({ type: 'simple', symbol: { type: 'esriSLS', color: [1, 2, 3, 255], width: 5 } })
    applyFeatureStyler(ds as never, fn)
    const line = (ds.entities.values[0] as any).polyline
    colorClose(line.material, 1, 2, 3)
    expect(line.width).toBe(5)
  })

  it('styleFn 返回 undefined 时不改实体', () => {
    const ds = { entities: { values: [{ properties: {}, polygon: {} }] } }
    applyFeatureStyler(ds as never, () => undefined)
    expect((ds.entities.values[0] as any).polygon.material).toBeUndefined()
  })

  it('无 entities 时安全 no-op', () => {
    expect(() => applyFeatureStyler({ entities: { values: [] } } as never, () => undefined)).not.toThrow()
  })
})
