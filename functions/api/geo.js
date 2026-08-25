// Cloudflare Pages Function：/api/geo —— 依据请求 IP 的国家归属返回"大概经纬度"（国家/地区质心）
// 读取 Cloudflare 提供的 CF-IPCountry 头（ISO 3166-1 alpha-2），映射到国家质心经纬度；
// 头部缺失或国家不在表内时，回退到默认经纬度 (35, 104)。
// 不依赖第三方 IP 库、不弹浏览器授权、不把用户 IP 转发给外部服务。

const DEFAULT = { lat: 35.0, lon: 104.0 }

// 国家/地区代码 -> 质心经纬度（近似，够"大概定位"用）
const COUNTRY_CENTROID = {
  CN: [35.8, 104.2], HK: [22.3, 114.1], MO: [22.2, 113.5], TW: [23.7, 121.0],
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-10.3, -52.9],
  AR: [-38.4, -64.2], CL: [-30.5, -71.3], CO: [4.6, -74.1], PE: [-9.2, -75.0],
  GB: [55.4, -3.4], IE: [53.2, -8.2], FR: [46.6, 2.2], DE: [51.2, 10.4],
  IT: [42.8, 12.8], ES: [40.4, -3.7], PT: [39.4, -8.2], NL: [52.2, 5.3],
  BE: [50.5, 4.5], CH: [46.8, 8.2], AT: [47.5, 14.5], SE: [62.0, 16.0],
  NO: [61.0, 10.0], DK: [56.0, 9.0], FI: [62.0, 26.0], PL: [52.1, 19.4],
  RU: [61.5, 105.3], UA: [48.4, 31.2], RO: [45.9, 24.9], GR: [39.0, 22.0],
  TR: [39.0, 35.2], CZ: [49.8, 15.5], HU: [47.2, 19.5],
  JP: [36.2, 138.2], KR: [35.9, 127.8], KP: [40.0, 127.0],
  IN: [21.0, 78.0], PK: [30.4, 69.4], BD: [23.7, 90.4], LK: [7.9, 80.7],
  NP: [28.4, 84.1], TH: [15.0, 101.0], VN: [14.1, 108.3], MY: [4.2, 102.0],
  SG: [1.35, 103.82], ID: [-0.8, 113.9], PH: [12.9, 121.8], AU: [-25.3, 133.8],
  NZ: [-41.8, 172.8], ZA: [-29.0, 24.7], EG: [26.8, 30.8], NG: [9.1, 8.7],
  KE: [0.02, 37.9], MA: [31.8, -7.1], SA: [23.9, 45.1], AE: [24.0, 54.0],
  IL: [31.5, 34.9], IR: [32.4, 53.7], IQ: [33.2, 43.7], KZ: [48.0, 66.9],
  GR: [39.0, 22.0],
}

export async function onRequest(context) {
  const country = (context.request.headers.get('cf-ipcountry') || '').toUpperCase()
  const c = COUNTRY_CENTROID[country]
  const lat = c ? c[0] : DEFAULT.lat
  const lon = c ? c[1] : DEFAULT.lon
  return new Response(JSON.stringify({ lat, lon, country }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
