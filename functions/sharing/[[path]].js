// Cloudflare Pages Functions：把 /sharing/* 请求代理到 www.arcgis.com（生产环境等价于 vite 开发代理）
// 部署到 Cloudflare Pages 后自动生效；其他平台参考 server/proxy.mjs
export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)
  const targetUrl = 'https://www.arcgis.com' + url.pathname + url.search
  const headers = new Headers(request.headers)
  headers.set('host', 'www.arcgis.com')
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  })
  // 透传响应 + 允许浏览器跨域读取
  const respHeaders = new Headers(upstream.headers)
  respHeaders.set('Access-Control-Allow-Origin', '*')
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}
