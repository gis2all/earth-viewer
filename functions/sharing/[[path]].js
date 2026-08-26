// Cloudflare Pages Functions：/sharing/* 代理到 www.arcgis.com（生产环境等价于 vite 开发代理）
// 加固：仅白名单路径 + 仅 GET/HEAD + Referer 检查 + 内存 Rate Limit
// 更强限流建议在 Cloudflare dashboard 配置 Rate Limiting 规则
const ALLOWED_PATHS = [
  /^\/sharing\/rest\/search($|\?)/,
  /^\/sharing\/rest\/content\/items\/[^/]+\/data($|\?)/,
  /^\/sharing\/rest\/content\/items\/[^/]+($|\?)/,
]

const RATE_WINDOW_MS = 60000
const RATE_MAX = 60
const hits = new Map()

function rateLimited(ip) {
  const now = Date.now()
  const entry = hits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS }
  if (entry.resetAt <= now) {
    entry.count = 0
    entry.resetAt = now + RATE_WINDOW_MS
  }
  entry.count += 1
  hits.set(ip, entry)
  return entry.count > RATE_MAX
}

function originAllowed(request, allowedOrigins) {
  const origin = request.headers.get('origin')
  if (!origin) return true // 非浏览器请求（同源 / curl）放行
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true
  if (allowedOrigins.some((o) => origin.startsWith(o))) return true
  return false
}

export async function onRequest(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const allowedOrigins = (env.ALLOWED_ORIGIN || '').split(',').filter(Boolean)

  // 1) 仅允许白名单路径
  if (!ALLOWED_PATHS.some((re) => re.test(url.pathname))) {
    return new Response('Not Allowed', { status: 403 })
  }
  // 2) 仅允许 GET / HEAD（代理不转发 POST 等）
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  // 3) Referer / Origin 检查（防止第三方站点滥用）
  if (!originAllowed(request, allowedOrigins)) {
    return new Response('Forbidden', { status: 403 })
  }
  // 4) 内存 Rate Limit（每 IP 每分钟 60 次）
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateLimited(ip)) {
    return new Response('Too Many Requests', { status: 429 })
  }

  const targetUrl = 'https://www.arcgis.com' + url.pathname + url.search
  const headers = new Headers(request.headers)
  headers.set('host', 'www.arcgis.com')
  const upstream = await fetch(targetUrl, { method: request.method, headers })
  const respHeaders = new Headers(upstream.headers)
  respHeaders.set('Access-Control-Allow-Origin', '*')
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}
