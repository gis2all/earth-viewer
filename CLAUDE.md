# CLAUDE.md — Earth Viewer 项目说明

> 本文件是本项目的**唯一权威参考**，涵盖：项目定位、技术栈、架构、核心实现与规则、设计决策（为什么）、已知限制、数据源、待办、历史踩坑、工程约定。
> 改代码前请先通读本文件 + 关键源码；**带 ★ 的是"绝不可回退"的规则**，改动前务必三思。

---

## 一、项目总览

**Earth Viewer**（代码目录 `D:\Code\earth-viz-hub`，曾用名 EarthViz Hub）：3D 地球可视化 Web 产品，目标是可以上线、不是 demo。

- **交互形态**：画廊式图层应用。
  - 左侧「图层」面板：「已添加」列表 + 「ArcGIS Online数据源」搜索画廊（点卡片加图层到球上）。
  - 右侧「效果」面板：调地球渲染效果（环境/地形/视图）。
  - 顶部：品牌标识 + 回正 / 复位 / 主题切换三个按钮。
- **UI 风格**：极简、现代化画廊风、**全直角**（无圆角）、不套双层卡片、深浅色双主题。
- **产品名**：Earth Viewer（页面标题、顶栏品牌、favicon 均已统一）。
- **品牌图标**：黑白斜切地球（白球/黑球 + 斜切 + 核心点），深浅主题各自反转。

---

## 二、技术栈与依赖

| 依赖 | 版本说明 |
|---|---|
| React | 18.3.x |
| Vite | 5.4.x（`vite-plugin-cesium`） |
| TypeScript | 5.6.x |
| **CesiumJS** | **1.144.0**（已精确锁定，勿改回 `^` 以免漂移） |
| zustand | 4.5.x（全局状态） |

- **渲染引擎只有 Cesium**；无 MapLibre、无时间轴（时间轴模块已删除）。
- 深浅色主题通过 `theme.css` 的 CSS 变量（`data-theme`）实现。

---

## 三、架构与目录

```
earth-viz-hub/
  index.html            # 页面标题 Earth Viewer + favicon links
  package.json          # name=earth-viewer
  vite.config.ts        # arcgis-online-proxy（/sharing 代理到 www.arcgis.com，绕 CORS）
  vitest.config.ts      # 单测配置（jsdom 全局，src/**/*.test.{ts,tsx}）
  eslint.config.js      # ESLint（typescript-eslint + react-hooks）
  playwright.config.ts  # E2E 冒烟测试（mock ArcGIS 请求，确定性）
  e2e/app.spec.ts       # 浏览器冒烟：加载→搜索→添加→删除
  functions/sharing/    # Cloudflare Pages Functions：/sharing/* 生产代理（arcgis.com，配置后续再做）
  server/proxy.mjs      # 通用 Node 生产服务（静态托管 dist + /sharing 代理，备选）
  server/nginx.conf     # Nginx 部署示例（备选）
  .github/workflows/ci.yml  # CI：lint + test + build + e2e
  CLAUDE.md             # 本文件
  docs/                 # ★不入 git（.gitignore 忽略），会话交接/规格等内部文档
  public/
    favicon-dark.svg    # 深色主题 favicon（白球黑切）
    favicon-light.svg   # 浅色主题 favicon（黑球白切）
    favicon-16/32.png   # PNG 兜底
    covers/*.png        # 图层卡片封面图
    data/countries.geojson
  src/
    main.tsx / App.tsx
    app/
      AppShell.tsx      # 顶栏（品牌图标、回正/复位/主题按钮、favicon 跟随主题）+ 左右面板布局
      LayerPanel.tsx    # 左侧画廊：预取+过滤+按浏览数排序+无限滚动
      EffectsPanel.tsx  # 右侧「效果」面板（环境/地形/视图）
    globe/
      GlobeViewer.tsx   # Cesium Viewer 核心：相机控制、图层管理、效果应用
      cameraApi.ts      # resetView / orientView（顶部按钮调用）
      webmap.ts         # ArcGIS webmap 解析、provider 构建、坐标系探测（detectCrs）
      assess.ts         # ★统一渲染能力评估器（能力表/角色分类/过滤与渲染共用）
    state/
      store.ts          # zustand：theme / collapsed / added / effects
    styles/
      theme.css         # 全部样式（直角、深浅主题变量、面板/画廊/效果控件）
```

**数据流**：
1. `LayerPanel` 搜索 ArcGIS Online → 预取每个 webmap JSON → `assessWebmap()` 过滤 → 展示可渲染项
2. 点卡片 → `addLayer` 写入 store（`added`）
3. `GlobeViewer` 监听 `added` → `renderableLayersFromWebmap()` 得到应渲染层 → 逐个构建 provider / GeoJSON DataSource 叠加到球上

---

## 四、核心实现与规则（★别改坏）

### 4.1 底图 & 地形（常驻，极区修复过）

- **底图三层**（Viewer 创建时加一次，之后只增删用户图层 → 不闪蓝）：
  1. **底层**：`World Imagery (WGS84)`（`wi.maptiles.arcgis.com`，EPSG:4326，覆盖 ±90°）——**极区兜底**
  2. 3857 `World_Imagery`（`server.arcgisonline.com`）
  3. `World_Boundaries_and_Places`（标注）
- **地形**：**`Terrain3D (GCSv2)`**（`tiles.arcgis.com/.../Terrain_3D_GCSv2/ImageServer`，EPSG:4326，覆盖 ±90°）。
  - ★必须用 4326 版地形。原因：3857 地形（旧 `WorldElevation3D/Terrain3D`）的 tilingScheme 是 Web Mercator（±85.05°），会让 Cesium globe 网格在 ±85.05° 截断，**极区连 globe tile 都没有，任何影像都贴不上**（表现为两极露出底色/星空）。
- 球体基色 `#0d1526`（图层加载间隙防露蓝）。

### 4.2 图层管理（★统一评估器 assess.ts）

- `added: AddedLayer[]`，`kind: 'webmap' | 'fallback'`，`webmap` 字段存完整 webmap JSON。
- **`assessWebmap(wm)` 是"能否渲染/渲染什么"的唯一事实源**，输出：
  ```ts
  { renderable: boolean, fidelity: 'full'|'partial'|'none', reason?, layers: LayerAssessment[] }
  ```
- **能力表**（`classifyLayer`）分三级：`full`（影像瓦片 MapServer/ImageServer、带图层名的 WMS、KML）、`partial`（FeatureLayer/FeatureServer/GeoJSONLayer——降级为 GeoJSON；WMS 缺图层名）、`none`（VectorTile / 3D Scene / 其他，带原因）。
- **tiled / dynamic 区分**：`detectMapService()` 探测服务 metadata 的 `tileInfo`——无 tileInfo 的动态 MapServer 不能走 `/tile/{z}/{y}/{x}`，provider 返回 null 且评估降级为不可渲染（LayerPanel 预取时精化）。
- **角色分类**：`basemap`（主底图）/ `overlay`（辅助层）/ `business`（业务层）。
  - ★overlay 判定用 URL 黑名单：`World_Hillshade | World_Boundaries_and_Places | World_Transportation | World_Reference | World_Terrain_Base | World_Shaded_Relief`。
  - ★**overlay 辅助层不渲染**（`renderableLayersFromWebmap` 过滤掉）——否则灰度 Hillshade 会盖住彩色底图，出现"地图全白"。
- **过滤与渲染共用同一评估结果**：LayerPanel 用 `renderable`；GlobeViewer 用 `renderableLayersFromWebmap`。不要在这两处各写一套判断。
- **投影自动探测**（`webmap.ts` 的 `detectCrs`）：请求服务 `?f=json` 读 `spatialReference.wkid`：
  - `4326` → `GeographicTilingScheme`
  - `102100 / 3857` / 其他 / 失败 → 默认 Web Mercator
  - 结果带模块级缓存（`CRS_CACHE`），探测失败静默回退，不影响现有行为。
- 渲染时应用图层 `opacity`（→ `ImageryLayer.alpha`）和 `visibility`（false 跳过）。
- **WMS / KML 已支持**：type 兼容 `"WMS"/"KML"` 与 `"WMSLayer"/"KMLLayer"`；WMS 用 `WebMapServiceImageryProvider`（图层名取 `layerName` 或 `layers` 数组首项），KML 用 `KmlDataSource`。
- **FeatureLayer 符号映射**：读服务 metadata 的 `drawingInfo.renderer`，SimpleRenderer（点/线/面）映射为 Cesium GeoJSON 样式；UniqueValue 等暂返回 null（默认样式）。
- **FeatureLayer 分页**：按 `maxRecordCount` + `resultOffset` 循环拉取，上限 5000 条；含**重复页面检测**（服务忽略 resultOffset 时停止），防止无限拉取。
- **图层加载失败用户可见**：GlobeViewer 加载 Feature/GeoJSON/KML 失败时写入 store `layerErrors`，已添加卡片显示「加载失败」红标（title 附原因），成功加载后清除。
- **状态持久化**：zustand persist（localStorage `earth-viewer`），保存 theme/collapsed/added/effects，刷新恢复。

### 4.3 画廊（LayerPanel）

- 搜索：`type:"Web Map" AND access:public`，走本地 vite 代理 `/sharing/rest/search`。
- **预取 + 过滤**：每页 24 条结果，分批（每批 6 个）拉取每个 webmap JSON 并用 `assessWebmap` 判断；纯矢量切片 / 纯辅助层 / 3D 场景的 webmap 被剔除。
- **自动翻页补齐**：一页过滤后不足 24 项继续翻页，直到凑够或搜索到底（12 页上限防死循环）。
- **按 `numViews`（浏览数）降序**排序。
- **缓存**：`assessCache`（Map<itemId, WebmapAssessment>）跨搜索复用，避免重复拉取。
- **搜索防抖 300ms + AbortController 取消 + requestId 序列号**：只有最新一次请求才更新 UI，彻底消除旧请求覆盖新结果；Enter 立即搜索、加载中有取消按钮。
- **能力角标**：`fidelity=partial` 的卡片显示"部分支持"；添加时若跳过不支持层，toast 提示具体图层名。
- 无限滚动：滚动接近底部触发 `loadMore(false)`。

### 4.4 相机（踩坑多，★别回退）

- 交互：**右键拖拽 = 倾斜**；滚轮 = 平滑缩放（只更新目标高度，每帧向目标缓动）；双击 = zoom in（飞向点击点一半高度）。
- 限制：`MIN_ZOOM=20m`、`MAX_ZOOM=25000000m`；pitch 钳制 `[-89.9°, 0°]`。
- ★**所有飞行动画统一用 `flyTo`；任何鼠标按下都要 `cancelFlight()`**（否则飞行中拖不动球）。
- 瓦片清晰度：缩放中 `maximumScreenSpaceError=4` → 稳定后 `=2`（迟滞防抖）。
- `onCameraFrame`（`postUpdate`）：自动环绕（无交互 3s 后、非飞行中）、pitch 钳制、缩放缓动。
- ★**自动环绕是"东西方向"**：`setView` 时经度递增（`carto.longitude + 0.0012`），保持纬度/高度/heading/pitch 不变——**不是原地转 heading**（原地转 heading 是错的，已修复）。

### 4.5 效果面板（术语已 GIS 化）

- **环境**：大气散射（Atmosphere）/ 星空背景（Stars）/ 日月（SunMoon）/ 雾效（Fog）/ 昼夜光照（DayNight）
- **地形**：
  - 地形透明（GlobeTranslucency）：开关 + 透明度滑杆（0.10–1.00，步进 0.05）；★滑杆随开关**显隐**（关闭时隐藏）
  - 地形夸张（TerrainExaggeration）：滑杆 1–3X
- **视图**：自动环绕（AutoRotate）
- ★半透明必须显式设 `frontFaceAlpha` / `backFaceAlpha`（默认都是 1 = 完全不透明；只设 `enabled=true` 没视觉效果）。当前正面 = 滑杆值，背面 = min(1, 滑杆值+0.1)。
- ★**实验组（云层/水面/极光）已全部删除**（2026-08-20），相关代码与 `cloudShell.ts` 已移除，**不要再加回**。
- Bloom 已关闭（`postProcessStages.bloom.enabled = false`，去掉图层发光）。

### 4.6 主题 & 品牌

- dark / light：背景跟随（深色 = 深空 + 可选星空；浅色 = 白底无星空）。变量在 `theme.css`。
- 顶栏品牌图标 = 黑白斜切地球 SVG，**随主题反转**（`AppShell` 里按 `theme` 给 fill/stroke 换黑白）。
- **favicon 随主题切换**：`AppShell` 的 effect 动态改 `<link rel="icon">` 的 href（dark → `favicon-dark.svg`，light → `favicon-light.svg`）。

---

## 五、设计决策记录（"为什么"）

| 决策 | 原因 |
|---|---|
| 地形/影像用 4326（GCSv2 + WGS84） | 3857 的 globe 网格截断在 ±85.05°，两极无 tile；必须 4326 才能覆盖 ±90° |
| 底层叠 4326 影像 + 上层 3857 | 低纬用 3857（瓦片更清晰/标准），极区自动穿透到底层 4326，不损失清晰度 |
| 统一评估器 assess.ts | 之前"发现一个问题打一个补丁"（VectorTile 过滤、Hillshade 黑名单…）永远追不完；把"能不能渲染"收敛成单一评估入口，过滤和渲染共用，新增类型只改能力表 |
| 跳过 overlay 辅助层 | Hillshade 单独渲染是全球灰度，盖住彩色底图 = 全白；辅助层只作叠加，不作为主内容 |
| 投影自动探测而非写死 | 4326 图层若按 3857 解释会出现条纹错位花屏 |
| 画廊预取 + 过滤（而非点击才校验） | 用户要求列表里只显示能用的，避免"点了没反应/白屏" |
| 不换 Esri ArcGIS JS API | 能 100% 渲染 webmap，但 4.x 需授权（credits）付费、现有 Cesium 代码全量重写、定制自由度下降；Cesium 免费开放更合适当前定位 |
| ArcGIS 公开服务匿名访问 | `sharing/rest/search`、公开瓦片服务无需账号、不消耗 credits（实测响应无 quota 字段）；真实风险是匿名速率限制（429），所以预取分批控制并发 |
| 品牌图标黑白斜切地球 | 硬线条、ArcGIS 风、简洁；黑白两色深浅主题各自反转，favicon 同步 |

---

## 六、已知限制（Cesium 能力边界）

- **不支持渲染 ArcGIS VectorTileLayer（MVT 矢量切片）**：Cesium 1.144 已移除实验性的 `VectorTileImageryProvider`。这类 webmap（如 Streets、Topographic 的矢量版）会被评估器过滤。
- **不支持 ArcGIS 3D Scene 图层**。
- **WMS / KML 已支持**；CSV / 动态服务等仍未声明，按"不支持"过滤；未来在 `classifyLayer` 加类型 + 写 provider 即可。
- 瓦片服务 metadata 请求失败的（CORS 等）会静默回退默认 3857（可能错位，但至少不崩）。
- `docs/` 不进 git；`*.log`、`*.tsbuildinfo`、`node_modules/`、`dist/` 已忽略。
- **安全边界**：CI 审计生产依赖（`npm audit --omit=dev`）；dev 链 vite→esbuild 有已知漏洞（修复需升 vite 8，breaking，暂缓，升级前勿用 `npm audit fix --force`）。代理层已加固（白名单路径 + GET-only + Referer + Rate Limit）。外部文本（title/snippet）走 React 文本渲染（自动转义），无 `dangerouslySetInnerHTML`，无注入点。

---

## 七、数据源参考（免费开源）

- Natural Earth（矢量）、NASA Earthdata（Blue Marble / 高程 / 夜间灯光）、GEBCO（海陆 DEM）、ERA5（气象）、WorldPop（人口）、USGS（地震 / 火山）、ESA 土地分类、EUMETSAT 云图（matteason/live-cloud-maps）。
- **ArcGIS Online 免费资源（匿名访问、不消耗 credits）**：
  - 搜索接口：`www.arcgis.com/sharing/rest/search`（本地经 vite 代理）
  - `World_Imagery`（3857）、`World Imagery (WGS84)`（4326）、`Reference/World_Boundaries_and_Places`（标注）
  - `Terrain_3D_GCSv2`（4326 地形）、`WorldElevation3D/Terrain3D`（3857 旧版，勿用于地形）
  - 瓦片模板格式：`.../MapServer/tile/{z}/{y}/{x}`

---

## 八、待办（按优先级）

1. **部署上线**：目标 Cloudflare Pages（`functions/sharing/` 已备好 ArcGIS 代理），Pages 项目配置（wrangler/_headers/构建）后续再做。CI（`npm run lint/test/build` + Playwright e2e）已就绪。
2. 气象 / 地震时序 + 时间轴（曾讨论，用户说排在 bug 修复之后）。
3. 能力角标与 toast 提示已实现，可继续打磨（如卡片 tooltip 展示具体跳过原因）。
4. ArcGIS Online 搜索已接入；可继续打磨搜索体验（排序、分页目标数量等）。

---

## 九、历史踩坑（防回归）

| 现象 | 根因 | 当前规则 |
|---|---|---|
| 南北极空白 | 3857 地形导致 globe 网格截断 ±85.05° | 用 4326 地形 + 4326 影像底层 |
| 4326 图层条纹花屏 | provider 写死 3857 tilingScheme | 探测 wkid，4326 → Geographic |
| 添加底图型 webmap 无反应 | 只渲染 operationalLayers，忽略 baseMapLayers | 评估器纳入 baseMap |
| 地图全白（Charted Territory / US Wildfire） | 只剩 Hillshade 灰度辅助层，不透明盖住底图 | 跳过 overlay 辅助层 |
| 地球半透明没效果 | alpha 默认 1，只开了 enabled | 显式设 front/backFaceAlpha |
| 自动旋转方向不对 | 原地递增 heading | 递增经度（东西向） |
| favicon 与网页图标不一致 | favicon 固定白球 | dark/light 两套 SVG 随主题切换 |
| 面板折叠/弹开跳动 | 布局/动画 | 保持现状，别动 |
| 图层多次加载/取消后残留 | 异步竞态 | `layerMapRef` 增量管理 + cancelled 标记 |
| 右键倾斜带动缩放 | 事件/控制器配置 | 右键=倾斜、滚轮=缩放分离 |
| flyTo 期间拖不动球 | 飞行未取消 | 鼠标按下 cancelFlight |
| 瓦片缩放模糊 | SSE 固定 | 缩放中 4 → 稳定 2（迟滞） |
| 球体蓝块 | 底图未加载露底色 | 基色 #0d1526 |
| 云层/水面/极光不真实 | 实验效果 | 已删除，勿加回 |

---

## 十、工程约定

- **不要频繁 git 提交**（用户明确要求，工作区大量未提交改动属正常）。
- **`docs/` 不入 git**；`*.tsbuildinfo`、`*.log`、`node_modules/`、`dist/` 均已忽略。
- 开发服务器日志**不要输出到项目根目录**（避免污染仓库根目录）；需要后台启动时把日志重定向到系统临时目录（如 `$env:TEMP\earthviz-dev.log`）。
- Windows 环境：写文件用 Python（utf-8、LF）；编码敏感文件别用 PowerShell 重定向写。
- 用户全中文交流，回复用中文。
- 用户对 UI 要求苛刻（讨厌"AI 感""太文艺"），**改 UI 前先讨论 / 看原型，别闭门造车**。
