import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveServiceItem } from './arcgisItem'

afterEach(() => vi.unstubAllGlobals())

describe('resolveServiceItem', () => {
  it('service items with url return a WebLayer with mapped layerType', async () => {
    const map = await resolveServiceItem({ id: 'a', type: 'Map Service', url: 'https://x/MapServer', title: 'M' })
    expect(map).toMatchObject({ url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' })
    const wfs = await resolveServiceItem({ id: 'b', type: 'WFS', url: 'https://x/wfs', title: 'W' })
    expect(wfs).toMatchObject({ layerType: 'WFS' })
  })

  it('Vector Tile Service adds styleUrl', async () => {
    const l = await resolveServiceItem({ id: 'c', type: 'Vector Tile Service', url: 'https://x/VectorTileServer', title: 'V' })
    expect(l?.styleUrl).toBe('https://x/VectorTileServer/resources/styles/root.json')
    expect(l?.layerType).toBe('VectorTileLayer')
  })

  it('WMS resolves layer name from capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<Capability><Layer><Name>roads</Name></Layer></Capability>' })))
    const l = await resolveServiceItem({ id: 'd', type: 'WMS', url: 'https://x/wms', title: 'W' })
    expect(l?.layerName).toBe('roads')
    expect(l?.layerType).toBe('WMSLayer')
  })

  it('WMTS resolves layer/tileMatrixSet/style/format', async () => {
    const xml = '<Capabilities><Layer><ows:Identifier>topo</ows:Identifier></Layer><TileMatrixSet><ows:Identifier>default</ows:Identifier></TileMatrixSet><Style><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format></Capabilities>'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => xml })))
    const l = await resolveServiceItem({ id: 'e', type: 'WMTS', url: 'https://x/wmts', title: 'T' })
    expect(l?.layerName).toBe('topo')
    expect(l?.tileMatrixSetID).toBe('default')
    expect(l?.style).toBe('default')
    expect(l?.format).toBe('image/png')
  })

  it('WMTS GetTile template url extracts layer/style/format/matrixSet', async () => {
    const url = 'https://x/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=grijs&STYLE=default&FORMAT=image/png&TILEMATRIXSET=EPSG:28992&TILEMATRIX={level}&TILEROW={row}&TILECOL={col}'
    const l = await resolveServiceItem({ id: 't2', type: 'WMTS', url, title: 'T' })
    expect(l?.layerName).toBe('grijs')
    expect(l?.style).toBe('default')
    expect(l?.format).toBe('image/png')
    expect(l?.tileMatrixSetID).toBe('EPSG:28992')
    expect(l?.url).toBe('https://x/wmts')
  })

  it('GeoJson/CSV file items fall back to /items/<id>/data', async () => {
    const gj = await resolveServiceItem({ id: 'gj1', type: 'GeoJson', title: 'G' })
    expect(gj?.url).toBe('/sharing/rest/content/items/gj1/data')
    expect(gj?.layerType).toBe('GeoJSONLayer')
    const csv = await resolveServiceItem({ id: 'cv1', type: 'CSV', title: 'C' })
    expect(csv?.url).toBe('/sharing/rest/content/items/cv1/data')
    expect(csv?.layerType).toBe('CSVLayer')
  })

  it('WMTS cannot resolve config -> returns service base (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const l = await resolveServiceItem({ id: 'w', type: 'WMTS', url: 'https://x/wmts', title: 'W' })
    expect(l?.url).toBe('https://x/wmts')
    expect(l?.layerName).toBeUndefined()
  })

  it('unknown type returns null', async () => {
    expect(await resolveServiceItem({ id: 'x', type: 'Streaming Service' })).toBeNull()
  })

  it('Scene Service 点云 -> 屏蔽（返回 null），不添加', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ layers: [{ id: 0, layerType: 'Point' }] }) })))
    const l = await resolveServiceItem({ id: 's1', type: 'Scene Service', url: 'https://x/SceneServer', title: 'Trees' })
    expect(l).toBeNull()
  })

  it('Scene Service 网格（3DObject）-> 可添加', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ layers: [{ id: 0, layerType: '3DObject' }] }) })))
    const l = await resolveServiceItem({ id: 's2', type: 'Scene Service', url: 'https://x/SceneServer', title: 'Buildings' })
    expect(l).toMatchObject({ url: 'https://x/SceneServer', layerType: 'ArcGISSceneServiceLayer' })
  })
})
