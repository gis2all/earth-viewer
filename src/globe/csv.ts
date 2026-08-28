import { withFetchTimeout, type WebLayer } from './facade/webmap'
import { SAFETY } from './loadSafety'

export interface CsvFeatureCollection {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: Record<string, string>
    geometry: { type: 'Point'; coordinates: [number, number] } | null
  }>
}

/** 解析 RFC 4180 常见 CSV：支持引号、逗号、换行和双引号转义。 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)

  const headers = (rows.shift() ?? []).map((header) => header.trim())
  return rows.map((values) =>
    headers.reduce<Record<string, string>>((record, header, index) => {
      if (header) record[header] = (values[index] ?? '').trim()
      return record
    }, {})
  )
}

function locationInfo(layer?: WebLayer): Record<string, unknown> {
  const definition = layer?.layerDefinition as { locationInfo?: Record<string, unknown> } | undefined
  return {
    ...(definition?.locationInfo ?? {}),
    ...(((layer as WebLayer & { locationInfo?: Record<string, unknown> })?.locationInfo) ?? {}),
  }
}

function findField(headers: string[], requested: unknown, candidates: RegExp): string | undefined {
  if (typeof requested === 'string' && headers.includes(requested)) return requested
  return headers.find((header) => candidates.test(header.trim()))
}

function coordinateFields(rows: Record<string, string>[], layer?: WebLayer): { lat?: string; lon?: string } {
  const headers = Object.keys(rows[0] ?? {})
  const info = locationInfo(layer)
  const lat = findField(
    headers,
    info.latitudeField ?? info.latitudeFieldName,
    /^(lat|latitude|y)$/i
  )
  const lon = findField(
    headers,
    info.longitudeField ?? info.longitudeFieldName,
    /^(lon|lng|longitude|x)$/i
  )
  return { lat, lon }
}

/** 拉取 CSV 并转换为 GeoJSON 点要素；没有可识别坐标时返回空集合。 */
export async function fetchCsvGeoJSON(url: string, layer?: WebLayer, signal?: AbortSignal): Promise<CsvFeatureCollection> {
  const response = await fetch(url, { signal: withFetchTimeout(signal) })
  if (!response.ok) throw new Error('CSV 图层加载失败')
  const text = await response.text()
  if (text.length > SAFETY.MAX_FILE_BYTES) throw new Error('\u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d')
  const rows = parseCsv(text).slice(0, SAFETY.MAX_FEATURES)
  const fields = coordinateFields(rows, layer)
  if (!fields.lat || !fields.lon) return { type: 'FeatureCollection', features: [] }

  const features = rows.flatMap((properties) => {
    const latitude = Number(properties[fields.lat as string])
    const longitude = Number(properties[fields.lon as string])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return []
    return [{
      type: 'Feature' as const,
      properties,
      geometry: { type: 'Point' as const, coordinates: [longitude, latitude] as [number, number] },
    }]
  })
  return { type: 'FeatureCollection', features }
}
