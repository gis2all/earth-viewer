import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import https from 'node:https'

// ArcGIS Online 代理：绕开浏览器 CORS（vite-plugin-cesium 会抢先拦截 /sharing，故用自定义中间件放在最前）
function arcgisOnlineProxy(): Plugin {
  return {
    name: 'arcgis-online-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/sharing')) return next()
        const url = 'https://www.arcgis.com' + req.url
        const proxyReq = https.request(
          url,
          { method: req.method, headers: { ...req.headers, host: 'www.arcgis.com' } },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
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
    },
  }
}

export default defineConfig({
  plugins: [arcgisOnlineProxy(), react(), cesium()],
  // maplibre-gl 的 module worker（?worker&url）需以 ESM 输出，否则 new Worker(url, { type: 'module' }) 失败
  worker: { format: 'es' },
})
