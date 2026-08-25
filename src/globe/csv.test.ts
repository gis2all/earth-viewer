import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCsvGeoJSON, parseCsv } from './csv'

describe('parseCsv', () => {
  it('解析带引号、逗号和换行的 CSV', () => {
    expect(parseCsv('name,lat,lon\n"Main, road",30.1,120.2\n"Second\nroad",31,121')).toEqual([
      { name: 'Main, road', lat: '30.1', lon: '120.2' },
      { name: 'Second\nroad', lat: '31', lon: '121' },
    ])
  })
})

describe('fetchCsvGeoJSON', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('按 WebMap 的 latitudeField/longitudeField 转成点 GeoJSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => 'name,lat,lon\nA,30,120\nB,31,121',
    })))

    const result = await fetchCsvGeoJSON('https://example.test/points.csv', {
      layerDefinition: {
        locationInfo: { latitudeField: 'lat', longitudeField: 'lon' },
      },
    })

    expect(result.features).toHaveLength(2)
    expect(result.features[0]).toEqual(expect.objectContaining({
      geometry: { type: 'Point', coordinates: [120, 30] },
    }))
  })

  it('找不到坐标字段时返回空要素集而不阻塞球面', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => 'name,value\nA,1',
    })))

    const result = await fetchCsvGeoJSON('https://example.test/attributes.csv')
    expect(result.features).toHaveLength(0)
  })
})
