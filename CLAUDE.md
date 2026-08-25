# CLAUDE.md — Earth Viewer · Agent 上手手册

> 本文件是 **Agent（Claude Code / Codex 等）接手本项目的唯一权威参考**：读完「30 秒速览」就能正确操作，需要细节时按章节/任务索引查。
> 改代码前请先通读本文件 + 相关源码；**带 ★ 的是"绝不可回退"的规则**，改动前务必三思。

---

## 0. 30 秒速览

- **项目**：画廊式 3D 地球图层应用。Cesium 渲染地球 + 接入 ArcGIS Online 公开图层（搜索 → 添加（点卡片时校验）→ 叠加），线上 https://earth.gis2all.top
- **代码**：`D:\Code\earth-viz-hub`；git remote = `github.com/gis2all/earth-viewer`
- **技术栈**：React 18 · CesiumJS 1.144（★精确锁定）· Vite 5 · TypeScript 5.6 · zustand；Node ≥ 22；Vitest + Playwright；Docker；Cloudflare Pages

| 命令 | 用途 |
|---|---|
| `npm run dev` | 本地开发 http://localhost:5173（内置 /sharing 代理） |
| `npm run test:coverage` | 单测 + 覆盖率门禁（★statements/lines ≥ 90%，当前 ~90.6%） |
| `npm run lint` / `npm run build` | ESLint / 生产构建（dist/） |
| `npm run test:e2e` | Playwright E2E（含真实 ArcGIS 集成） |
| `docker compose up --build` | Docker 运行（5173） |
| `npx wrangler pages deploy --project-name=earth-viewer` | 部署到 Cloudflare Pages（需 token） |

**★ 不可违反规则**（详见对应章节）：
1. CesiumJS 锁 1.144.0，勿改回 `^`（§2）
2. 地形必须用 4326 版 GCSv2；底层 4326 影像兜底（§6.1）
3. 渲染能力判断只用 `assess.ts` 统一评估器，别在两处各写一套（§6.2）
4. 生产 CSP 的 `script-src` 必须含 `blob:`（否则球空白）；CSP 唯一来源是 `public/_headers`（§6.6）
5. 未经用户明确准许，不得执行 `git add / commit / push`（§14）

**常见任务索引**：新增图层类型 → §11 T1 · 加效果开关 → §11 T2 · 跑全套验证 → §11 T3 · 部署 Pages → §11 T4 · 提交代码 → §11 T5 · 排查球空白 → §11 T6

---

## 1. 项目定位

**Earth Viewer**：画廊式 3D 地球图层应用（曾用名 EarthViz Hub），目标是可以上线、不是 demo。左侧「图层」面板搜索 ArcGIS Online Web Map/Web Scene ，点卡片时校验并按类型叠加到 Cesium 球上；右侧「效果」面板调节环境/地形/视图；顶栏回正/复位/主题切换。深浅色双主题，全直角 UI。

---

## 2. 技术栈与依赖

| 依赖 | 版本说明 |
|---|---|
| React | 18.3.x |
| CesiumJS | **1.144.0**（★精确锁定，勿改回 `^`） |
| Vite | 5.4.x（`vite-plugin-cesium`，生产注入经典 Cesium.js） |
| TypeScript | 5.6.x（strict） |
| zustand | 4.5.x（全局状态 + persist localStorage `earth-viewer`） |
| proj4 / @mapbox/vector-tile / pbf | ArcGIS 数据转换：坐标重投影 / MVT 矢量瓦片解码 |
| maplibre-gl | 6.6.x：矢量瓦片官方样式（root.json）离屏渲染 → 自定义 ImageryProvider 喂给 Cesium |
| Vitest / Testing Library | 单测 + 覆盖率（v8 provider） |
| Playwright | E2E |
| Node.js | **≥ 22**（CI/Docker 统一 + package.json `engines` 与 .npmrc `engine-strict` 本地强制；Cesium 要求） |
| Docker | 两阶段镜像（node:22-alpine），Compose 运行 |
| Cloudflare Pages + wrangler | 生产部署 |

- 渲染引擎是 **Cesium**；矢量瓦片样式渲染用 **MapLibre GL**（离屏 3×3 块栅格化后经自定义 ImageryProvider 贴到 Cesium 球上，见 `maplibreImagery.ts`）；无时间轴（已删除）。
- 端口统一 **5173**（dev / node proxy / nginx / Docker）；CSP 唯一来源 `public/_headers`。

---

## 3. 运行方式

### 3.1 本地开发
```text
npm install
npm run dev        # http://localhost:5173
```
vite 内置 `/sharing` 代理（转发 `www.arcgis.com`，绕 CORS）。★5173 被占时 vite 自动递增（5174/5175），常见是残留 dev server 进程，先清理（§13）。

### 3.2 生产构建 + Node 代理（自托管）
> ★构建注意：maplibre 的 worker 通过 new URL(..., import.meta.url) 动态加载，vite 无法静态解析。
> 已用 import ... from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url' + vite.config.ts 的 worker.format='es'
> 把它打包成**自包含 ESM worker**（否则生产构建只复制单文件、缺 maplibre-gl-shared.mjs 依赖 → 样式永不 load）。
```text
npm run build               # dist/
node server/proxy.mjs 5173  # 静态托管 dist + /sharing 代理（默认 5173）
```

### 3.3 Docker
```text
docker compose up --build   # http://localhost:5173
docker compose down
```
两阶段：node:22-alpine 构建（npm ci + build）→ 运行（dist + proxy.mjs，无 npm 依赖）。

### 3.4 Cloudflare Pages（生产线上）
- 线上：https://earth.gis2all.top（Pages 项目 `earth-viewer`，pages.dev 地址 `earth-viewer-9rw.pages.dev`）
- 部署方式：本地 `npx wrangler pages deploy --project-name=earth-viewer`（GitHub 自动集成未启用）
- ★**部署前置**：`CLOUDFLARE_API_TOKEN` 必须含 `Cloudflare Pages > Edit` 权限 + `CLOUDFLARE_ACCOUNT_ID`（见 §10、§11 T4）
- 详细配置/排查见 §10

---

## 4. 架构与目录

```
earth-viz-hub/
  README.md             # 用户向简介（含产品图标/截图/6 徽章）
  CLAUDE.md             # 本文件（Agent 上手手册）
  LICENSE               # MIT
  index.html            # 页面标题 Earth Viewer + favicon（★无内联 CSP，见 _headers）
  package.json          # name=earth-viewer
  vite.config.ts        # /sharing 代理中间件 + react + cesium 插件
  vitest.config.ts      # 单测 + ★coverage 门槛（include 全 src，exclude 入口/测试 + worker/primitive（dataWorker.ts、primitive.ts））
  eslint.config.js      # ESLint
  playwright.config.ts  # E2E（baseURL 5173，json reporter 输出 e2e-results.json）
  Dockerfile / docker-compose.yml / .dockerignore
  wrangler.toml         # Pages 配置：pages_build_output_dir = "dist"（★不能含 account_id）
  scripts/badge.mjs     # 从 coverage/audit/test/e2e 数据生成 4 个徽章 JSON
  functions/sharing/[[path]].js  # Pages Functions：/sharing/* 代理（白名单+GET-only+Origin+限流）
  functions/api/geo.js       # Pages Function：/api/geo → CF-IPCountry 国家质心经纬度（用户大概定位）
  server/
    proxy.mjs           # Node 生产服务（静态 dist + /sharing 代理）
    nginx.conf          # Nginx 示例
  e2e/                  # Playwright：冒烟 / UI 交互 / 真实 ArcGIS 集成
  .github/workflows/ci.yml  # CI：audit → lint → test:coverage → build → e2e → badge → Pages 徽章发布
  docs/                 # ★不入 git（.gitignore）
  public/
    logo.svg / screenshot.jpg   # README 产品图标与截图（进 dist）
    favicon-dark.svg / favicon-light.svg / favicon-16/32.png
    covers/*.png / data/countries.geojson
    _headers            # ★CSP/安全头/缓存唯一来源（Pages 生效）
    _redirects          # SPA 回退 /* /index.html 200
  src/
    main.tsx / App.tsx
    app/
      AppShell.tsx      # 顶栏（品牌/回正/复位/主题）+ favicon 跟随主题 + 面板布局
      LayerPanel.tsx    # 画廊：支持类型白名单并行搜索+轻预筛+排序+无限滚动，点卡片时校验
      EffectsPanel.tsx  # 效果面板（环境/地形/视图开关与滑杆）
    globe/
      GlobeViewer.tsx   # Cesium 核心：Viewer 创建、相机、效果、图层增量、相机优先/userHome 回退（★__E2E__ 模式）
      cameraApi.ts      # registerViewer/unregisterViewer/resetView/orientView/flyToHome（用户定位+启动高度）
      geo.ts            # 用户大概定位：/api/geo + localStorage 缓存 + 硬编码兜底
      webmap.ts         # webmap 解析、provider 构建、detectCrs/detectMapService、Feature 分页
      assess.ts         # ★统一渲染能力评估器（classifyLayer/assessWebmap/renderableLayersFromWebmap）
      itemTypes.ts      # 可搜索 item type 白名单（SEARCH_ITEM_TYPES / isWebMapContainer）
      serviceItem.ts    # 单图层服务 item（Map/Feature/Scene…）→ 包装成可渲染 webmap
      csv.ts / vector.ts / vectorTile.ts / ogc.ts / scene.ts / loadSafety.ts  # 各数据源：转GeoJSON/Provider + 预算
      kml.ts            # KML → GeoJSON 轻量转换（走 Worker 预算管线），失败回退原生 KmlDataSource
      viewport/         # 视口驱动渲染管线（query/worker/simplify/budget/geometryModel/primitive/cluster/lru/viewportController）
    state/store.ts      # zustand：theme/collapsed/added/effects/layerErrors/userHome
    styles/theme.css    # 全部样式（直角、深浅主题变量）
```

**数据流**：`LayerPanel` 按支持类型白名单并行搜索（`sortField=numViews`）→ 轻预筛直接上屏 → 点卡片 `addLayer` → `GlobeViewer` 监听 `added` → `renderableLayersFromWebmap()` 构建 provider/DataSource 叠加。

---

## 5. 文件职责（改代码前先看这里）

| 文件 | 职责 | 关键导出/依赖 |
|---|---|---|
| `src/globe/assess.ts` | ★"能否渲染"唯一事实源：能力表、角色分类、整体评估 | `classifyLayer`、`assessWebmap`、`renderableLayersFromWebmap`；被 LayerPanel 与 GlobeViewer 共用 |
| `src/globe/webmap.ts` | webmap JSON 解析、服务探测、provider/GeoJSON 构建 | `fetchWebmap`、`detectMapService`（CRS_CACHE）、`providerForWebLayer`、`fetchFeatureGeoJSON/Style` |
| `src/globe/GlobeViewer.tsx` | Cesium Viewer 创建/销毁、按需渲染、相机控制、效果、图层生命周期；相机优先/userHome 回退；★`window.__E2E__` 时跳过 Cesium | 依赖 store、cameraApi、webmap、assess、scene/vector/vectorTile/ogc/csv/loadSafety/kml/viewport |
| `src/globe/cameraApi.ts` | 顶部按钮复位/回正 + 用户定位飞行 | `registerViewer/unregisterViewer/resetView/orientView/flyToHome/setInitialHeightForTest` |
| `src/app/LayerPanel.tsx` | 画廊：搜索/预取/过滤/流式上屏/无限滚动/添加移除/错误 toast | 依赖 store、webmap、assess |
| `src/app/AppShell.tsx` | 布局、品牌图标、favicon 主题切换、回正/复位按钮 | 依赖 store、cameraApi、GlobeViewer/LayerPanel/EffectsPanel |
| `src/state/store.ts` | 全局状态 + persist | theme/added/effects/layerErrors/userHome + actions |
| `functions/sharing/[[path]].js` | Pages 生产代理（/sharing → www.arcgis.com） | 白名单 search/data；Origin 检查读 `ALLOWED_ORIGIN` |
| `functions/api/geo.js` | Pages Function：/api/geo 用户国家质心经纬度 | `onRequest` 读 `CF-IPCountry` |
| `src/globe/geo.ts` | 用户大概定位：请求 /api/geo、缓存、硬编码兜底 | `fetchUserHome`/`getUserHome`/`resetUserHomeCache` |
| `src/globe/itemTypes.ts` | 可搜索 item type 白名单与容器判定 | `SEARCH_ITEM_TYPES`/`isWebMapContainer` |
| `src/globe/serviceItem.ts` | 单图层服务 item 包装为可渲染 webmap | `resolveServiceItem` |
| `src/globe/csv.ts / vector.ts / vectorTile.ts / ogc.ts / scene.ts / loadSafety.ts` | 各数据源→GeoJSON/Provider/防卡死 | `fetch*GeoJSON`/`loadI3S`/`load3DTiles`/`fetchVectorTileTemplates`/`riskOfLayer` |
| `src/globe/maplibreImagery.ts` | ★VectorTile 官方样式渲染（方案 A）：MapLibre 离屏 3×3 块批量栅格化 → Cesium `ImageryProvider` | `ArcGisVectorTileImageryProvider`/`normalizeArcGisStyle`/`tileCenterLngLat`/`cropTile` |
| `src/globe/viewport/` | 视口驱动渲染管线：按相机视口查询 FeatureLayer + Worker 解析/抽稀/顶点与要素预算 + LRU 缓存 + Primitive 渲染 | `queryViewportData`/`runViewportProcess`/`createViewportController`/`applyVertexBudget`/`clusterPoints`/`buildLayerPrimitive`/`viewportCacheKey` |
| `src/globe/kml.ts` | KML → GeoJSON 轻量转换（走 Worker 预算管线），失败回退原生 KmlDataSource | `parseKmlToGeoJSON`/`kmlStyleToFeatureStyle` |
| `scripts/badge.mjs` | 从数据文件生成徽章 JSON | 读 coverage-summary / audit / test-results / e2e-results |

---

## 6. 核心实现与规则（★别改坏）

### 6.1 底图 & 地形（常驻，极区修复过）
- **底图三层**（Viewer 创建时加一次，之后只增删用户图层）：① `World Imagery (WGS84)`（`wi.maptiles.arcgis.com`，EPSG:4326，±90° 极区兜底）② 3857 `World_Imagery`（`server.arcgisonline.com`）③ `World_Boundaries_and_Places`（标注）
- **地形**：`Terrain3D (GCSv2)`（`tiles.arcgis.com`，EPSG:4326，±90°）。★必须 4326——3857 地形 tilingScheme 截断 ±85.05°，极区无 globe tile，任何影像都贴不上。
- 球体基色 `#0d1526`（加载间隙防露蓝）。

### 6.2 图层管理（★统一评估器 assess.ts）
- `added: AddedLayer[]`，`kind: 'webmap' | 'fallback'`，webmap 存完整 JSON。
- `assessWebmap(wm)` 输出 `{ renderable, fidelity: 'full'|'partial'|'none', reason?, layers }`；**过滤与渲染共用**（LayerPanel 用 renderable，GlobeViewer 用 renderableLayersFromWebmap）。
- 能力表 `classifyLayer`：`full`（MapServer/ImageServer 瓦片、动态服务 export、带名 WMS/WMTS、KML、**VectorTile（MapLibre 官方样式）**）/ `partial`（FeatureLayer/GeoJSON/CSV/WFS/OGC 降级、I3S、3D Tiles、WMS 缺名）/ `none`（无地址或明确不支持，带原因）。
- tiled/dynamic 区分：`detectMapService` 读 `tileInfo`；动态 MapServer/ImageServer 无 `/tile/` 模板 → 用 `/export?bbox={westDegrees}...` 出图（支持）。
- 角色：`basemap`/`overlay`/`business`；★overlay 用 URL 黑名单（Hillshade 等）且**不渲染**（否则灰度盖住彩色底图=全白）。
- 投影自动探测 `detectCrs`：4326 → Geographic；其余/失败 → Web Mercator；`CRS_CACHE` 缓存。
- FeatureLayer：SimpleRenderer 符号映射；`maxRecordCount`+`resultOffset` 分页（拉取上限 `MAX_FEATURES=3000`、重复页检测）。渲染时另受单层 `MAX_RENDER_FEATURES=1500`、业务层合计 `MAX_TOTAL_FEATURES=5000` 约束。
- 加载失败写入 `layerErrors`（卡片红标）；状态 persist。
- 防卡死（loadSafety.ts）：风险分级 + 阈值 + 降级（全球矢量底图影像化、矢量 maxZoom 16、Feature/WFS/OGC/CSV 3000、GeoJSON ≤8MB、KML ≤2MB、WMS maximumLevel 16、Scene/3D SSE=16）；点聚合、串行渲染队列、字段裁剪（outFields=1）。
- ★渲染健壮性（防 OOM/卡死，GlobeViewer）：① 业务层数量上限 `MAX_BUSINESS_LAYERS=5`（超限省略并提示）；② 业务层总要素预算 `MAX_TOTAL_FEATURES=5000`（`consumeFeatureBudget`，超预算略过后续层）；③ 单层 `MAX_RENDER_FEATURES=1500`（数据大只取前 N 个并提示）；④ fetch 可取消（`rec.abort`，移除图层即中止）；⑤ `renderQueue` 加 `.catch` 兜底（单个 webmap 渲染失败不卡整队列）。
- ★**按需渲染（GPU 空闲保护）**：Viewer 固定 `requestRenderMode: true` + `maximumRenderTimeChange: Infinity`。静止场景不持续提交 GPU 帧；效果、地形、影像层、DataSource、Primitive、VectorTile provider、删除路径、`camera.flyTo` 和 `webglcontextrestored` 改变场景后，必须调用 `requestSceneRender(v)`（`cameraApi` 通过 `requestViewerRender`）请求一帧。滚轮缓动与自动环绕仅在各自动画生效期间由 `onCameraFrame` 请求下一帧；不得在静止路径无条件 `requestRender()`，也不得每帧重复写入相同 SSE 值。按需渲染不替代图层/要素/瓦片缓存预算。
- **P1–P5 视口驱动管线**（`src/globe/viewport/`）：FeatureLayer 只按相机视口 query（`resolveFeatureQueryBase` 自动解析第一个可查询层，`buildFeatureQueryUrl` 基于已解析的层号 + `geometry=envelope` + `f=geojson`），Worker 解析 → Douglas-Peucker 抽稀 → 顶点预算（`MAX_RENDER_VERTICES=200_000`）→ 要素预算（`MAX_RENDER_FEATURES`），Primitive 优先渲染（`buildLayerPrimitive`）、`hasPrimitiveRendering` 失败回退 `GeoJsonDataSource`；相机 `moveEnd` → `viewportController.update` 随视口更新，LRU 缓存视口结果。
- **VectorTile（方案 A，maplibreImagery.ts）**：不再用 `MVTDataProvider` 裸几何、也不降级 OSM 栅格——用真实 MapLibre 按官方 `root.json` 离屏渲染（sprite/glyphs/paint/layout）。MapLibre 与 ArcGIS VectorTile 的原生瓦片均为 512px，因此自定义 `ImageryProvider` 也原生输出 512px：Cesium 会据此选择对应的 LOD，MapLibre 和 Cesium 使用同一 `z/x/y`，不做旧方案的 z-1 补偿或默认下采样；相关单测覆盖层级、裁剪与世界边缘中心收拢。实际浏览器的连续缩放仍须视觉回归验证，不能据此宣称所有样式和缩放场景已与 ArcGIS 完全一致。每次以 3×3×512px（1536px）离屏渲染，单次 GPU 读回后裁出 9 张 512px 瓦片；`renderWorldCopies: false` 在世界边缘会收拢 MapLibre 相机，裁剪必须读取 `getCenter()` 的实际中心，不能假定 `jumpTo()` 请求中心，否则会错取相邻瓦片造成数十度偏移。LRU 只缓存最终瓦片；512px 单片像素为旧方案四倍，因此块上限为 12（约 108 MiB 像素缓冲）。样式规范化会把 `VectorTileServer`（含官方相对 `../../` URL）转换为 XYZ PBF 模板，并移除对 vector source 非法的 `tileSize`。每个块等待 MapLibre `idle`（瓦片/字体/sprite 稳定）后才缓存，避免把加载中的透明区域固化。防卡死手段：① 3×3 块批量 + LRU；② 每块仅一次 GPU readPixels；③ 串行队列 + 单块失败不阻塞；④ `VECTOR_TILE_MAX_ZOOM=16`；⑤ 销毁时拒绝所有未决瓦片请求。
- **KML 预算**：KML → `parseKmlToGeoJSON` → `runViewportProcess`（顶点/要素预算）→ `GeoJsonDataSource`，失败/无要素回退原生 `KmlDataSource.load`，仍受 `KML_MAX_BYTES=2MB` 限制。
- **业界防卡死全景（跨类型 1–10）**：① FeatureLayer 视口取数；② WFS/OGC/CSV/KML/GeoJSON 走 Worker 预算管线（runViewportProcess）；③ FeatureLayer 用 Primitive 渲染；④ 点聚类 + 线面抽稀；⑤ 全局/逐层顶点与要素上限；⑥ 瓦片缓存 tileCacheSize + LRU + 分页 + 3D LOD 流式；⑦ SSE 分级（大视图更粗）；⑧ FeatureLayer moveEnd 防抖（250ms）；⑨ 矢量瓦片用 MapLibre 离屏 3×3 块批量栅格化（不再降级 OSM）；⑩ WebGL context lost 监听 → 优雅提示。
- 内嵌 FeatureCollection（layerDefinition.featureCollection）走 `runViewportProcess` 预算后 `GeoJsonDataSource` 渲染；WebTiledLayer/urlTemplate 也设 maximumLevel（与 WMS/WMTS 一致）。
- FeatureLayer（多图层 FeatureServer）默认优先解析“分色渲染器（uniqueValue/classBreaks）”的事件层（如 NWS Watch），而非静态 zones；有渲染器时走 GeoJsonDataSource + applyFeatureStyler 分色，避免单一纯色大块。
- Feature Service（多图层）采用分层渲染：区划/参考层（simple）可由 effects.showReferenceLayers 开关控制（默认开，低预算 REF_LAYER_MAX 描边，避免盖住事件层），事件层（uniqueValue/classBreaks）全部填充分色，每层独立预算不互相挤占，并自动飞到服务数据范围（fit-to-data）。
- 健壮性：Feature 服务探测图层 id（非固定 /0） + f=geojson 不支持时回退 f=json 转 GeoJSON；WMTS 解析不到配置不抛错（返回服务根降级）。

### 6.3 画廊（LayerPanel）
- ★只保留权威内容：查询串（buildSearchQuery）强制追加 `contentstatus` 权威过滤（org/public_authoritative，排除 deprecated）；详见 §6.7。
- ★服务可用性预检：服务类/容器后台预检，`Token Required`/`Subscription canceled`/`403` 等不可访问卡片自动隐藏；详见 §6.7。
- 按支持 item type 白名单并行搜索（13 类），各取一页后按 numViews 合并去重；sortField=numViews&sortOrder=desc。
- 轻预筛：搜索阶段不逐项拉 data、不做能力预评估；点卡片时才解析/渲染，不支持才 toast。
- 每轮只拉未到底类型一页，滚动到底再翻下一页。
- 服务 item 经 resolveServiceItem 包装为单图层；GeoJson/CSV 用 /items/<id>/data。
- 防抖 300ms + AbortController + requestId 序列号。
- 取消/清除按钮：loading && kw.length > 0 才显示。
### 6.4 相机（★别回退）
- 右键拖拽=倾斜；滚轮=平滑缩放（目标高度缓动）；双击=zoom in 一半高度。
- 限制：`MIN_ZOOM=20m`、`MAX_ZOOM=25,000km`；pitch `[-89.9°, 0°]`。
- ★所有飞行统一 `flyTo`；任何鼠标按下 `cancelFlight()`（否则飞行中拖不动球）。
- 瓦片清晰度：缩放中 SSE=4 → 稳定后=2（迟滞）。
- ★自动环绕是**东西方向**：`setView` 经度递增 `+0.0012`，保持纬度/高度/朝向——不是原地转 heading。

- ★相机/用户定位：Web Map/Scene 带 `viewpoint.camera` → 飞其相机（3857 反投影 + heading/tilt）；无相机 → `flyToHome()`（`userHome` + `initialHeight`）。首次进入加载完成后自动居中到 `userHome`。
- `userHome`：用户大概经纬度，来自 `/api/geo`（CF-IPCountry → 国家质心），失败回退 `(35,104)`；由 `src/globe/geo.ts` 提供并缓存。★本地 dev 无 Cloudflare，/api/geo 404 → 走兜底。

### 6.5 效果面板
- 环境：大气散射/星空/日月/雾效/昼夜光照；地形：地形透明（开关+透明度滑杆，★滑杆随开关显隐）、地形夸张 1–3X；视图：自动环绕。
- ★半透明必须显式设 `frontFaceAlpha`/`backFaceAlpha`（默认 1 不透明；正面=滑杆值，背面=min(1, 值+0.1)）。
- ★实验组（云层/水面/极光）已删除，勿加回；Bloom 关闭。

### 6.6 CSP 与安全（★生产渲染依赖）
- ★CSP 唯一来源 `public/_headers`（index.html **无**内联 CSP）；`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`、`worker-src 'self' blob:`。
- ★`script-src` 的 `blob:` 绝不能删：生产经典 Cesium.js 把 worker 内联 base64，worker 用 `importScripts(blob:)`，被拦则**球空白**（dev ESM 构建无此问题）。
- `functions/sharing/` 代理加固：白名单路径（search/data）+ GET/HEAD + Origin 检查（`ALLOWED_ORIGIN`）+ 内存限流；本地 proxy.mjs 转发并加 ACAO。
- CI 审计生产依赖；dev 链 vite→esbuild 有已知漏洞（升 vite 8 为 breaking，暂缓，勿 `npm audit fix --force`）。


### 6.7 ArcGIS 搜索请求（数据源过滤器）

> 画廊/搜索的一切后端请求逻辑集中在这一章：**构建查询 → 并行搜索 → 预检可用性 → 渲染过滤**。改这里之前先通读，尤其注意 6.7.2 的坑。

> 官方文档：Search 接口 <https://developers.arcgis.com/rest/users-groups-and-items/search/> · Search reference <https://developers.arcgis.com/rest/users-groups-and-items/search-reference/> · Items and item types <https://developers.arcgis.com/rest/users-groups-and-items/items-and-item-types/>

### 6.7.1 请求流水线（入口 `src/app/LayerPanel.tsx`）

1. **构建查询** `buildSearchQuery(type, keyword)`：
   `type:"<类型>" AND access:public AND (<权威过滤>) [AND (keyword)]`
   - 类型来自白名单 `SEARCH_ITEM_TYPES`（`src/globe/itemTypes.ts`，13 类：Web Map/Scene、Map/Feature/Image/Scene Service、KML、Vector Tile、WMS/WMTS/WFS、GeoJson、CSV）。
   - 权威过滤 `AUTHORITATIVE_FILTER`：
     `AND (contentstatus:"org_authoritative" OR contentstatus:"public_authoritative") NOT contentstatus:"deprecated"`
2. **并行搜索** `fetchSearchPage`：对每个「未到底」的类型各发一页；URL 参数 `q / f=json / num=12 / start / sortField=numViews&sortOrder=desc`；请求走 `/sharing` 代理（绕 CORS）。
3. **合并** `mergeSearchResults`：按 id 去重 + numViews 降序。
4. **预检** `preflightItem`（异步后台、不阻塞首屏，并发 4 + 3s 超时）：
   - 服务类 → GET 服务根 `?f=json`
   - 容器（Web Map/Scene）→ GET `/sharing/rest/content/items/<id>/data?f=json`
   - 命中 `Token Required` / `Subscription canceled` / `403` → 加入 `badIds` **自动隐藏**
   - 结果按 item id 缓存 `localStorage`（key `earth-viewer:preflight`，24h TTL）
5. **渲染**：画廊卡片按 `badIds` 过滤，已知不可用项不渲染。

### 6.7.2 关键注意点（坑，务必牢记）

- **权威字段是 `contentstatus`**，不是 `content`、更不是 `authoritative`。
  - `content:"org_authoritative"` → **0**；`authoritative:true` → **0**（无效字段）。
  - `contentstatus` 取值：`org_authoritative`(≈35k) / `public_authoritative`(≈12k) / `deprecated`(≈11k) / 空。
- **排序参数名是 `sortField` + `sortOrder`**（官方文档里 `sort` 出现两次是排版错位，第二个其实是 `sortOrder`；`count` 同理，后文才是 `countFields`/`countSize`）。
- **`num` 上限 100**；**`total` 精确到 10000 封顶** → 无法靠 total 判断过滤是否生效，用 `countFields=contentstatus` 验证（注意路径是 `aggregations.counts[0].fieldValues`）。
- **`typekeywords:"Living Atlas"` 几乎无用**（全类型仅 ~5 条），不能靠它筛 Living Atlas。
- **`orgid:` 需要组织真实 ID**（形如 `5uh3wwYLNzBuU0Ef`），不是用户名；`orgid:"esri"` → 0。
- **item JSON 不含 `contentstatus`** → 权威/废弃过滤只能服务端做，客户端拿不到（所以一切过滤都在 `q`/`filter` 里）。
- **官方 ArcGIS 页面 ≠ 匿名 API 口径**：官方 UI 的 `Status: Authoritative` 带登录组织上下文（个人账号→0）；我们匿名 API 是全平台公开权威（≈35k）。二者不是同一套口径。
- **type 白名单严格精确**（实测每类返回的 `type` 全都一致，不会混入 Table 等）；但**数据本体可能不可访问**（如 `rki_*`：item 是 Feature Service、权威，但服务根 `Token Required`、封面 403、`data` 订阅取消）→ 这类靠「6.7.1 的预检」兜底。
- **Web Map/Scene 容器也要预检**（走 `/items/<id>/data`），否则订阅取消的容器会漏进来（如 `RKI Corona Karte`）。

### 6.7.3 相关文件

| 文件 | 职责 |
|---|---|
| `src/app/LayerPanel.tsx` | `buildSearchQuery` / `fetchSearchPage` / `mergeSearchResults` / `preflightService` / `preflightItem` / 渲染过滤 |
| `src/globe/itemTypes.ts` | `SEARCH_ITEM_TYPES` / `isWebMapContainer` |
| `src/globe/loadSafety.ts` | `SAFETY` 上限（含 MAX_FEATURES/MAX_RENDER_FEATURES/MAX_RENDER_VERTICES/KML_MAX_BYTES/VECTOR_TILE_MAX_ZOOM） / `consumeFeatureBudget` / 升降级风险 |
| `vite.config.ts` | dev 代理 `/sharing` → `www.arcgis.com` |
| `functions/sharing/[[path]].js` | 生产 Pages 代理（白名单 + 只 GET/HEAD + Origin + 限流） |
| `server/proxy.mjs` | Node 自托管代理 |

### 6.7.4 测试

- `src/app/LayerPanel.test.tsx`：关键词防抖、Web Map/Scene 并行合并去重、Map Service 解析包装、**服务类预检不可用→自动隐藏**。
- `src/globe/loadSafety.test.ts`：`consumeFeatureBudget`（空/超预算/降级）、`riskOfLayer`、`degradeReason`、`assertUrlWithinLimit`。
- `src/globe/maplibreImagery.test.ts`：样式规范化（sprite/glyphs/VectorTileServer→tiles 模板、官方相对服务 URL、非法 vector `tileSize` 移除）、原生 512px Cesium/MapLibre 同级 LOD、边缘中心收拢后的实际中心裁剪、块缓存命中、`idle` 后截屏、readyPromise 成功/失败/销毁、串行队列吞错、销毁拒绝未决请求、默认 createMap 走真实 MapLibre 构造。
- `src/globe/GlobeViewer.test.tsx`：业务层超限提示、非法 webmap 触发渲染队列兜底、VectorTile 走 MapLibre 样式 provider（含失败销毁）、WFS/CSV/Feature 预算降级与 `signal`、KML 转 GeoJSON/回退。
- 新增请求/预检逻辑务必同步补测试；维持覆盖率门槛（statements/lines ≥ 90）。
- 每次改动跑：`npm run lint` → `npm run test:coverage` → `npm run build` → `git diff --check`。
---

## 7. 测试与质量门禁

- **单测**：Vitest（jsdom），316 个用例（含 store/cameraApi/AppShell/assess/webmap/LayerPanel/EffectsPanel/GlobeViewer/geo/itemTypes/serviceItem/VectorTile/OGC/CSV/vector/loadSafety/**maplibreImagery**）。`npm run test:coverage`
- **覆盖率门槛**（vitest.config.ts）：★statements ≥90 / lines ≥90 / functions ≥85 / branches ≥70（当前 90.56% / 95.58% / 93.73% / 80.88%）；include **全 src**（含 GlobeViewer），exclude 入口壳与测试文件——真实口径，不玩数字。
- **E2E**：Playwright 28 项（冒烟 mock / WebScene UI / UI 交互 mock / 真实 ArcGIS 集成 request）。
- ★**E2E 轻量模式**：`e2e/app.spec.ts`、`e2e/ui.spec.ts` 注入 `window.__E2E__`，GlobeViewer 跳过 Cesium 创建（CI 无头软件渲染极慢会拖垮交互测试）；「球真实渲染+图层上球」由线上/容器验证覆盖（headless 测不准渲染）。
- `src/globe/GlobeViewer.test.tsx` 覆盖按需渲染配置，以及效果和异步 MapServer 图层变更后调用 `scene.requestRender()`；改动任何异步上球路径时必须保留对应刷新断言。
- **徽章**：6 个（CI / License / Coverage / Deps / Tests / E2E）；`scripts/badge.mjs` 从 coverage-summary/audit/test-results/e2e-results 生成 JSON → GitHub Actions 发布到 GitHub Pages → shields endpoint 渲染，**每次 CI 实时生成**。
- **CI**（.github/workflows/ci.yml）：audit（--omit=dev）→ lint → test:coverage → build → e2e → badge → upload-pages-artifact（main 分支 deploy 到 Pages）。

---

## 8. 已知限制（Cesium 能力边界）

- ArcGIS VectorTileLayer 用 MapLibre 按官方样式离屏渲染（`maplibreImagery.ts`），不依赖 `MVTDataProvider`；WebScene 纯 `styleUrl` 直接用 `styleUrlForLayer` 取样式。低缩放/高密度区域（如 z3 亚洲）单帧绘制耗时偏高，headless 软件渲染更明显，真机 GPU 正常。部分 ArcGIS 样式引用的 sprite 图标可能在 MapLibre 中缺失；连续缩放的位置一致性仍需以真实浏览器视觉回归确认。
- 当 WebGL 上下文丢失（内存不足/卡死）时触发 `webglcontextlost` 监听，显示降级提示而非白屏；
- 静止场景已启用 Cesium 按需渲染，降低闲置 GPU 占用；但浏览器 GPU 进程仍受驱动、系统显存及多张重型/VectorTile 地图叠加影响，按需渲染不是显存硬上限。
- 3D Tiles / I3S 已设 cacheBytes=128MB / overflow=32MB，WMTS、动态 MapServer export 已设 maximumLevel=和业界其他平台一致的预算上限。
- ArcGIS SceneServer/I3S 使用 Cesium `I3SDataProvider`；3D Tiles 使用 `Cesium3DTileset`。
- 动态 MapServer/ImageServer 使用 `/export` 的 4326 影像兜底；不依赖 `/tile/`。
- WMS/WMTS/KML 支持（KML 先转 GeoJSON 走预算，失败回退原生）；Feature/GeoJSON/CSV/WFS/OGC API Features 转 GeoJSON 降级渲染。
- FeatureLayer/GeoJSON 降级为 GeoJSON：SimpleRenderer 映射；常规拉取/视口查询上限 3000、单层渲染上限 1500、同一 webmap 的业务层合计上限 5000；属性/符号分级部分丢失。
- 瓦片 metadata 探测失败静默回退 3857（可能错位但不崩）。
- dev 链 vite→esbuild 已知漏洞（升 vite 8 breaking，暂缓）。
- ArcGIS 匿名访问有速率限制（429），画廊预取分批（每批 6）控制并发。
- `functions/sharing/` 白名单只放行 search / webmap data（`/sharing/rest/info` 等返回 403 是预期）。
- 本地 dev 无 Cloudflare，`/api/geo` 会 404 → `userHome` 回退 `(35,104)`；国家质心为"大概"定位，城市级需第三方 IP 库。
- Web Scene 的 `viewingMode:'local'`（局部坐标系）相机暂未覆盖，仅处理 global。

---

## 9. 设计决策（"为什么"）

| 决策 | 原因 |
|---|---|
| 地形/影像用 4326 | 3857 globe 网格截断 ±85.05°，两极无 tile；4326 覆盖 ±90° |
| 底层 4326 影像 + 上层 3857 | 低纬 3857 更清晰，极区穿透到底层 4326 |
| 统一评估器 assess.ts | "发现一个问题打一个补丁"追不完；把"能否渲染"收敛为单一入口，新增类型只改能力表 |
| 跳过 overlay 辅助层 | Hillshade 单独渲染=全球灰度盖底图=全白 |
| 投影自动探测 | 4326 图层按 3857 解释会条纹错位花屏 |
| 画廊预取+过滤（非点击才校验） | 列表只显示能用的，避免"点了没反应/白屏" |
| 搜索按 numViews 降序 | 默认相关度首页几乎全是 VectorTile 底图，过滤后空画廊 |
| 画廊按批流式上屏 | 凑满 24 才渲染 = 90s+ 空白；每批上屏首卡 ~10s |
| 端口统一 5173 / Node 22 | 避免端口与版本割裂（Cesium 要求 ≥22） |
| Cesium 按需渲染 | 静止时不持续提交 GPU 帧；异步数据完成后显式请求一帧，动画期间才连续重绘 |
| 生产经典 Cesium.js + CSP blob: | vite-plugin-cesium 生产注入经典版；其 worker 走 blob importScripts |
| 不换 Esri ArcGIS JS API | 4.x 需授权付费、现有代码全量重写；Cesium 免费开放合适 |
| ArcGIS 公开服务匿名访问 | 搜索/瓦片无需账号不耗 credits；风险是 429，分批并发 |
| 品牌图标黑白斜切地球 | 硬线条 ArcGIS 风、简洁；深浅主题反转，favicon 同步 |
| Cloudflare Pages 而非 Workers | 本项目是静态站点+Functions 代理；Workers 项目类型会导致 wrangler pages deploy 报"项目不存在" |
| 相机优先 / 用户位置回退 | Web Map/Scene 有 `viewpoint` 就用作者视角；无相机数据回退到 userHome，避免"加了却看不到"或飞到任意 extent 乱跳 |
| 矢量瓦片用 MapLibre 栅格化而非 MVTDataProvider | 尽可能复用官方样式的 sprite/字体/paint/layout；裸几何解码难以复现样式，全球 MVTDataProvider 还会内存爆炸。取舍：栅格化贴球（ImageryLayer）+ 3×3 块批量 + 单次快照读回，避免卡死；视觉一致性以真实浏览器回归为准 |
| 用户定位用 /api/geo（国家质心）+ 硬编码兜底 | 自托管、不弹浏览器授权、不把用户 IP 给第三方；本地 dev 无 Cloudflare 走兜底 |
| 多数据类型统一支持（ArcGIS→Cesium） | 统一评估器 + 分类型 provider/DataSource，避免"发现一个问题打一个补丁" |
| 防卡死 loadSafety | 超大服务/全球矢量会拖垮页面，风险分级+阈值降级 |

---

## 10. 部署与上线（Cloudflare Pages）

- **线上**：https://earth.gis2all.top（Pages 项目名 `earth-viewer`；pages.dev 备用域名 `earth-viewer-9rw.pages.dev`）。
- **项目来源**：由 Cloudflare API 创建（Direct Uploads 类型，非 GitHub 集成）；**连接 GitHub 自动部署未启用**，部署靠本地 wrangler 命令。
- **部署命令**：`npx wrangler pages deploy --project-name=earth-viewer`（读取 `wrangler.toml` 的 `pages_build_output_dir=dist` + `functions/`）。
- **前置条件**：
  - 环境变量 `CLOUDFLARE_API_TOKEN`（★必须含 `Account > Cloudflare Pages > Edit` 权限；"Edit Cloudflare Workers" 模板**不含** Pages 权限 → 10000）
  - 环境变量 `CLOUDFLARE_ACCOUNT_ID=20e8a62a0f78502e23ef1be970f9e5cb`（或本地直接设）
  - ★`wrangler.toml` **不能含 `account_id`**（Pages 配置校验会报错）；不能写 `[assets]`（那是 Workers 模式）
- **环境变量（Pages 项目）**：`ALLOWED_ORIGIN=https://earth.gis2all.top`（★必设，否则浏览器请求被代理 Origin 检查 403）。
- **构建配置**：build command `npm run build`，输出 `dist`，生产分支 `main`；**Builds 设置里的 build token 若失效**（"belongs to a user who left"）需在 dashboard 换新。
- **安全头/CSP/缓存**：`public/_headers`；SPA 回退 `public/_redirects`。★CSP 只对 Pages 生效（本地 dev / Docker 无内联 CSP）。
- 域名绑定：`earth.gis2all.top` CNAME → `earth-viewer-9rw.pages.dev`（已在 Cloudflare 完成）。
- `functions/api/geo.js` 是 Pages Function，随 `functions/` 一起部署；`/api/geo` 读 `CF-IPCountry` 返回用户国家质心经纬度（无需额外环境变量）。

---

## 11. 任务式操作指南（Agent 干活时照着做）

### T1 新增一个图层类型（如 CSV）
1. `src/globe/assess.ts` → `classifyLayer` 能力表加类型判定（full/partial/none + 原因）
2. `src/globe/webmap.ts` → `providerForWebLayer`（或 DataSource 分支）写 provider/加载逻辑
3. `src/globe/GlobeViewer.tsx` → `renderOperationalLayers` 消费新类型
4. 补 `assess.test.ts` / `webmap.test.ts` 用例，跑 `npm run test:coverage` 确认门槛过
5. 更新 §8 已知限制

### T2 加一个效果开关
1. `src/state/store.ts` → `Effects` 接口加字段 + 初始值
2. `src/app/EffectsPanel.tsx` → GROUPS 加开关/滑杆项
3. `src/globe/GlobeViewer.tsx` → 效果 useEffect 里应用
4. 补 EffectsPanel/GlobeViewer 测试；跑验证

### T3 跑全套验证（改代码后必做）
```text
npm run lint
npm run test:coverage    # 门槛不过 = CI 会红
npm run build
npm run test:e2e         # 需网络（真实 ArcGIS）
docker compose up --build && 浏览器验证球渲染+画廊   # 有 Docker 改动时
```

### T4 部署到 Cloudflare Pages
```powershell
$env:CLOUDFLARE_API_TOKEN = "<Pages Edit 权限的 token>"
$env:CLOUDFLARE_ACCOUNT_ID = "20e8a62a0f78502e23ef1be970f9e5cb"
npm run build
npx wrangler pages deploy --project-name=earth-viewer
# 验证：curl https://earth.gis2all.top/ 与 /sharing/rest/search
```

### T5 提交代码
1. **未经用户明确准许不得提交**（★）
2. 分功能批次：`git add <具体文件>` + `git commit -m "<英文 message>"`（每批只含相关文件）
3. 用户说"推送"才 `git push origin main`

### T6 排查"球空白 / 静止后不刷新"
1. 生产/Docker 环境 → 检查 `_headers` 的 CSP `script-src` 是否含 `blob:`（★常见根因）
2. dev 正常但生产空白 → 经典 Cesium.js worker blob 被 CSP 拦（§6.6）
3. 若刚改过图层加载 → 看 `layerErrors` 红标 / `fetchFeatureGeoJSON` 分页
4. 若新图层/异步数据在静止球上不出现 → 确认场景变更后调用 `requestSceneRender(v)`；勿关闭 `requestRenderMode` 作为临时绕过

---

## 12. 待办

- ~~搜索排序~~（已完成：numViews + 流式上屏）

---

## 13. 历史踩坑（防回归）

| 现象 | 根因 | 当前规则 |
|---|---|---|
| 南北极空白 | 3857 地形截断 ±85.05° | 4326 地形 + 4326 影像底层 |
| 4326 图层条纹花屏 | provider 写死 3857 tilingScheme | 探测 wkid，4326 → Geographic |
| 添加底图型 webmap 无反应 | 只渲染 operationalLayers | 评估器纳入 baseMap |
| 地图全白（Charted Territory/US Wildfire） | Hillshade 灰度辅助层盖底图 | 跳过 overlay 辅助层 |
| 地球半透明没效果 | alpha 默认 1，只开 enabled | 显式设 front/backFaceAlpha |
| 自动旋转方向不对 | 原地递增 heading | 递增经度（东西向） |
| favicon 与网页图标不一致 | favicon 固定白球 | dark/light 两套 SVG 随主题 |
| 图层多次加载/取消残留 | 异步竞态 | layerMapRef 增量管理 + cancelled |
| 右键倾斜带动缩放 | 事件配置 | 右键=倾斜、滚轮=缩放分离 |
| flyTo 期间拖不动球 | 飞行未取消 | 鼠标按下 cancelFlight |
| 瓦片缩放模糊 | SSE 固定 | 缩放中 4 → 稳定 2（迟滞） |
| 球体蓝块 | 底图未加载露底色 | 基色 #0d1526 |
| 云层/水面/极光不真实 | 实验效果 | 已删除勿加回 |
| Docker/生产球空白 | 经典 Cesium.js worker 走 importScripts(blob:)，CSP script-src 无 blob: | CSP 加 blob:（★勿删） |
| 画廊 90s+ 空白 | 凑满 24 可渲染项才 setItems | 按批流式上屏（onBatch） |
| 画廊没数据 | ArcGIS 默认相关度首页全 VectorTile | 搜索带 sortField=numViews |
| 无限滚动 items 膨胀 | onBatch 用累积 pageAcc 追加 | 追加用本批 partial |
| 容器端口映射失效 | 5173 被残留 dev server 占用 | 先查端口清理再 compose up |
| **Cloudflare：wrangler deploy 报 Missing entry-point** | 用 Worker 命令部署 Pages 项目 | 用 `wrangler pages deploy` |
| **Cloudflare：Pages 项目不存在** | 建成了 Workers 项目（非 Pages） | 确认项目类型（API 查 pages/projects） |
| **Cloudflare：认证 10000** | token 无 Cloudflare Pages Edit 权限 | token 必须含 Pages > Edit（Workers 模板不够） |
| **Cloudflare：build token 失效** | 绑定已离开用户的 token | dashboard Builds → API token 换新 |
| **Cloudflare：wrangler.toml 报错** | 含 account_id（Pages 不支持） | 去掉 account_id，用 CLOUDFLARE_ACCOUNT_ID 环境变量 |
| 连续快速搜索把旧请求的游标写进新搜索 | 旧请求 Abort 不及时仍写入 nextStartsRef/pendingRef | 游标/缓冲写入前判断 `requestId === requestIdRef.current`（LayerPanel loadMore） |

---

## 14. 工程约定

- ★**未经用户明确准许，不得执行 `git add` / `git commit` / `git push`**（含「提交并推送」类自动操作）；只有用户明确说「提交/推送」才执行。
- `docs/` 不入 git；`coverage/`、`test-results.json`、`e2e-results.json`、`audit.json`、`*.log`、`*.tsbuildinfo`、`node_modules/`、`dist/` 已忽略。
- 开发日志不要输出到项目根目录；后台启动重定向到系统临时目录（如 `$env:TEMP\earthviz-dev.log`）。
- Windows 写文件用 Python/Node（utf-8、LF）；编码敏感文件别用 PowerShell 重定向写。
- 用户全中文交流，回复用中文。
- 用户对 UI 要求苛刻（讨厌"AI 感/太文艺"），**改 UI 前先讨论/看原型**。
- Docker/部署改动后必须实测（容器或线上验证球渲染与画廊），不能只看构建通过。
