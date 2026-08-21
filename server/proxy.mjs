// 通用 Node 生产代理：/sharing/* → www.arcgis.com
// 用法（示例）：node server/proxy.mjs 5173   （仅用于没有托管 Functions 的 Node 环境）
import http from 'node:http'
import https from 'node:https'

const PORT = Number(process.argv[2] || 5173)
const TARGET_HOST = 'www.arcgis.com'

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/sharing')) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const target = 'https://' + TARGET_HOST + req.url
  const proxyReq = https.request(
    target,
    { method: req.method, headers: { ...req.headers, host: TARGET_HOST } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' })
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', () => {
    res.writeHead(502)
    res.end('arcgis proxy error')
  })
  if (req.method === 'POST' || req.method === 'PUT') req.pipe(proxyReq)
  else proxyReq.end()
})

server.listen(PORT, () => {
  console.log('arcgis proxy listening on ' + PORT + ' (host static files alongside this)')
})
