import { describe, it, expect } from 'vitest'
import { parseKmlToGeoJSON, kmlStyleToFeatureStyle } from './kml'

const NS = 'xmlns="http://www.opengis.net/kml/2.2"'

describe('parseKmlToGeoJSON', () => {
  it('parses a Point placemark with name/description', () => {
    const kml = `<kml ${NS}><Document><Placemark><name>City</name><description>a city</description><Point><coordinates>121.5,31.2,0</coordinates></Point></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [121.5, 31.2] })
    expect(fc.features[0].properties.name).toBe('City')
    expect(fc.features[0].properties.description).toBe('a city')
  })

  it('parses a LineString', () => {
    const kml = `<kml ${NS}><Document><Placemark><LineString><coordinates>0,0 10,10 20,0</coordinates></LineString></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [10, 10], [20, 0]] })
  })

  it('parses a Polygon with inner ring', () => {
    const kml = `<kml ${NS}><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 0,10 10,10 10,0 0,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>2,2 2,8 8,8 8,2 2,2</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    const g = fc.features[0].geometry as { type: string; coordinates: number[][][] }
    expect(g.type).toBe('Polygon')
    expect(g.coordinates).toHaveLength(2)
    expect(g.coordinates[0]).toHaveLength(5)
  })

  it('parses a MultiGeometry into a Multi* geometry', () => {
    const kml = `<kml ${NS}><Document><Placemark><MultiGeometry><Point><coordinates>1,1</coordinates></Point><Point><coordinates>2,2</coordinates></Point></MultiGeometry></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].geometry).toEqual({ type: 'MultiPoint', coordinates: [[1, 1], [2, 2]] })
  })

  it('parses gx:Track coordinates', () => {
    const kml = `<kml ${NS} xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track><when>2020-01-01</when><gx:coord>1 2 0</gx:coord><gx:coord>3 4 0</gx:coord></gx:Track></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].geometry).toEqual({ type: 'LineString', coordinates: [[1, 2], [3, 4]] })
  })

  it('resolves inline Style color and icon href', () => {
    const kml = `<kml ${NS}><Document><Style id="s"><IconStyle><color>ff0000ff</color><Icon><href>https://x/icon.png</href></Icon></IconStyle><LineStyle><color>ff00ff00</color><width>3</width></LineStyle><PolyStyle><color>7f0000ff</color></PolyStyle></Style><Placemark><styleUrl>#s</styleUrl><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    const style = fc.features[0].properties.kmlStyle
    expect(style).toBeDefined()
    expect(style?.iconHref).toBe('https://x/icon.png')
    expect(style?.lineColor).toEqual([0, 255, 0, 255])
    expect(style?.lineWidth).toBe(3)
    expect(style?.fillColor).toEqual([255, 0, 0, 127])
  })

  it('resolves StyleMap normal branch', () => {
    const kml = `<kml ${NS}><Document><Style id="base"><IconStyle><color>ff0000ff</color></IconStyle></Style><StyleMap id="m"><Pair><key>normal</key><styleUrl>#base</styleUrl></Pair></StyleMap><Placemark><styleUrl>#m</styleUrl><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].properties.kmlStyle?.markerColor).toEqual([255, 0, 0, 255])
  })

  it('returns empty feature collection on parser error / no placemark', () => {
    expect(parseKmlToGeoJSON('<not-kml').features).toHaveLength(0)
    expect(parseKmlToGeoJSON(`<kml ${NS}><Document></Document></kml>`).features).toHaveLength(0)
  })
})

describe('kmlStyleToFeatureStyle', () => {
  it('converts line/fill/marker into FeatureStyleSpec', () => {
    const st = kmlStyleToFeatureStyle({
      lineColor: [0, 255, 0, 255],
      lineWidth: 3,
      fillColor: [255, 0, 0, 127],
      markerColor: [1, 2, 3, 4],
    })
    expect(st).toEqual({ stroke: [0, 255, 0, 255], strokeWidth: 3, fill: [255, 0, 0, 127], markerColor: [1, 2, 3, 4] })
  })

  it('returns undefined for empty style', () => {
    expect(kmlStyleToFeatureStyle(undefined)).toBeUndefined()
    expect(kmlStyleToFeatureStyle({ iconHref: 'https://x/i.png' })).toBeUndefined()
  })
})

  it('合并混合多几何时回退首个几何', () => {
    const kml = `<kml ${NS}><Document><Placemark><MultiGeometry><Point><coordinates>1,1</coordinates></Point><LineString><coordinates>0,0 10,10</coordinates></LineString></MultiGeometry></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [1, 1] })
  })

  it('嵌套 MultiGeometry 转换为 Multi*', () => {
    const kml = `<kml ${NS}><Document><Placemark><MultiGeometry><MultiGeometry><Point><coordinates>1,1</coordinates></Point></MultiGeometry></MultiGeometry></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].geometry).toEqual({ type: 'MultiPoint', coordinates: [[1, 1]] })
  })

  it('无合法几何的 Placemark 不产生要素', () => {
    const kml = `<kml ${NS}><Document><Placemark><name>OnlyName</name></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features).toHaveLength(0)
  })

  it('内联 Style 无 id 也能为 Placemark 解析样式', () => {
    const kml = `<kml ${NS}><Document><Placemark><Style><LineStyle><color>ff0000ff</color></LineStyle></Style><LineString><coordinates>0,0 1,1</coordinates></LineString></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].properties.kmlStyle?.lineColor).toEqual([255, 0, 0, 255])
  })

  it('StyleMap 无 normal 关键时回退首个 Pair', () => {
    const kml = `<kml ${NS}><Document><Style id="b"><IconStyle><color>ff0000ff</color></IconStyle></Style><StyleMap id="m"><Pair><key>highlight</key><styleUrl>#b</styleUrl></Pair></StyleMap><Placemark><styleUrl>#m</styleUrl><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`
    const fc = parseKmlToGeoJSON(kml)
    expect(fc.features[0].properties.kmlStyle?.markerColor).toEqual([255, 0, 0, 255])
  })

  it('退化 Polygon（外环不足 4 点）不产生要素', () => {
    const kml = `<kml ${NS}><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,1 2,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`
    expect(parseKmlToGeoJSON(kml).features).toHaveLength(0)
  })

  it('gx:Track 坐标不合法时不产生要素', () => {
    const kml = `<kml ${NS} xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track><gx:coord>bad bad bad</gx:coord><gx:coord>1 2 0</gx:coord></gx:Track></Placemark></Document></kml>`
    expect(parseKmlToGeoJSON(kml).features).toHaveLength(0)
  })

  it('只含未知子几何的 MultiGeometry 不产生要素', () => {
    const kml = `<kml ${NS}><Document><Placemark><MultiGeometry><Model><Location>1,2,0</Location></Model></MultiGeometry></Placemark></Document></kml>`
    expect(parseKmlToGeoJSON(kml).features).toHaveLength(0)
  })

  it('仍存载眠异常时回退空集合', () => {
    expect(parseKmlToGeoJSON('不是 XML').features).toHaveLength(0)
  })
