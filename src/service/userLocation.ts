// 客户端"大概定位"：优先请求 Cloudflare Pages Function /api/geo（国家质心经纬度），失败回退硬编码。
// 本地 dev（无 Cloudflare）时 /api/geo 会 404，走硬编码兜底。
// 结果缓存到 localStorage，避免每次重复请求。
import { fetchJson } from './http'
import type { UserHome } from '../domain/types'

const FALLBACK: UserHome = { lat: 35.0, lon: 104.0 }
const CACHE_KEY = 'earth-viewer:userHome'

let cached: UserHome | null = readCache()

function readCache(): UserHome | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as UserHome
    if (typeof parsed.lat === 'number' && typeof parsed.lon === 'number') return parsed
  } catch {
    // ignore
  }
  return null
}

function writeCache(v: UserHome) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(v))
  } catch {
    // ignore
  }
}

/** 同步读取已缓存的 userHome；没有则返回 null（调用方决定是否触发 fetch）。 */
export function getUserHome(): UserHome | null {
  return cached
}

/** 异步获取 userHome：/api/geo -> 失败/404/无数据 -> 硬编码兜底。结果缓存。 */
export async function fetchUserHome(): Promise<UserHome> {
  if (cached) return cached
  try {
    const r = await fetchJson<Response>('/api/geo', undefined, { throwHttpErrors: false })
    if (r.ok) {
      const j = (await r.json()) as { lat?: number; lon?: number }
      if (typeof j.lat === 'number' && typeof j.lon === 'number') {
        const v: UserHome = { lat: j.lat, lon: j.lon }
        cached = v
        writeCache(v)
        return v
      }
    }
  } catch {
    // fall through
  }
  cached = FALLBACK
  writeCache(FALLBACK)
  return cached
}

/** 测试用：清空内存缓存。 */
export function resetUserHomeCache() {
  cached = readCache()
}
