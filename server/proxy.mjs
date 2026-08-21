// 通用 Node 生产服务：静态托管 dist/ + /sharing/* 代理到 www.arcgis.com
// 用法：npm run build 后执行  node server/proxy.mjs 5173
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] || 5173)
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const TARGET_HOST = 'www.arcgis.com'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

function serveStatic(req, res, urlPath) {
  let filePath = path.normalize(path.join(DIST, urlPath === '/' ? 'index.html' : urlPath))
  // 防目录穿越
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback
      filePath = path.join(DIST, 'index.html')
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  })
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0]
  if (urlPath.startsWith('/sharing')) {
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
    return
  }
  serveStatic(req, res, urlPath)
})

server.listen(PORT, () => {
  console.log('earth-viewer serving dist/ + arcgis proxy on ' + PORT)
})
