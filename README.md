# <img src="public/logo.svg" width="32" height="32" alt=""> Earth Viewer

[![CI](https://github.com/gis2all/earth-viewer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gis2all/earth-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Coverage](https://img.shields.io/endpoint?url=https://gis2all.github.io/earth-viewer/coverage.json)](https://gis2all.github.io/earth-viewer/)
[![Deps](https://img.shields.io/endpoint?url=https://gis2all.github.io/earth-viewer/deps.json)](https://github.com/gis2all/earth-viewer/actions)
[![Tests](https://img.shields.io/endpoint?url=https://gis2all.github.io/earth-viewer/tests.json)](https://github.com/gis2all/earth-viewer/actions)
[![E2E](https://img.shields.io/endpoint?url=https://gis2all.github.io/earth-viewer/e2e.json)](https://github.com/gis2all/earth-viewer/actions)

3D 地球图层应用：Cesium 渲染地球，接入 ArcGIS Online 公开图层，搜索、评估、添加、叠加和管理地图图层，并实时调节地球渲染效果。

![Earth Viewer](public/screenshot.jpg)

## 技术栈

| 技术 | 职责 |
| --- | --- |
| React 18 | UI 组件 |
| CesiumJS  | 3D 地球渲染 |
| TypeScript 5.6 | 类型安全 |
| Vite 5 | 开发与构建 |
| zustand | 全局状态与持久化 |
| proj4 / @mapbox/vector-tile / pbf | ArcGIS 数据转换 |
| Vitest / Testing Library | 单元测试 |
| Playwright | E2E 浏览器回归 |
| Node.js（内置 http） | 生产静态托管 + `/sharing` ArcGIS 代理 |
| Docker | 容器化运行 |

## 快速开始

### 一、本机 Node 方式

需要 Node.js 22 与 npm：

```text
npm install
npm run dev
```

启动后访问 http://127.0.0.1:5173 。开发态已内置 `/sharing` 代理（vite 中间件转发到 `www.arcgis.com`，绕开浏览器 CORS）。

### 二、Docker 方式

需要 Docker（含 Compose）：

```text
docker compose up --build
```

构建镜像会先执行 `npm ci && npm run build` 生成生产产物，再由内置 Node 服务同时托管静态文件与 `/sharing` ArcGIS 代理。启动后访问 http://127.0.0.1:5173 。停止：`docker compose down`；需要改端口时，修改 `docker-compose.yml` 的 `ports` 映射。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务 |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run preview` | 本地预览生产构建产物 |
| `npm run test` | 运行 Vitest 单元测试 |
| `npm run test:coverage` | 单元测试 + 覆盖率门槛（≥90%） |
| `npm run lint` | ESLint 代码检查 |
| `npm run check:arch` | 架构门禁（依赖矩阵 + lint） |
| `npm run test:e2e` | 运行 Playwright E2E（含真实 ArcGIS 集成，需网络） |
| `node server/proxy.mjs 5173` | 生产静态托管 + ArcGIS 代理（先执行 `npm run build`） |

GitHub Actions 在 `push`（main）与 `pull_request` 时执行：`npm audit --omit=dev`（生产依赖审计）、`npm run check:arch`（架构门禁，含 lint）、`npm run test:coverage`（单元测试 + 覆盖率门槛）、生产构建、Playwright E2E。

## 架构

```mermaid
flowchart TD
    App[app 表现层<br/>React 组件 / store 订阅]
    Ctrl[controller 控制器<br/>DI 依赖注入]
    Svc[service 数据与调度<br/>repository / loader / scheduler / http / formats / processing]
    Dom[domain 纯 TS 零依赖<br/>类型 / 契约 / 配置 / 状态机 / 几何]
    Globe[globe 渲染适配<br/>globeRenderer + viewport]
    Infra[infra Cesium / MapLibre 深度封装<br/>cesiumFacade / gpuMemoryManager]

    App --> Ctrl
    App --> Svc
    App --> Globe
    App --> Infra
    App --> Dom
    Ctrl --> Svc
    Ctrl --> Dom
    Ctrl --> Globe
    Svc --> Dom
    Globe --> Svc
    Globe --> Infra
    Globe --> Dom
    Infra --> Svc
    Infra --> Dom
```

六层单向依赖（外层依赖内层，反向禁止，`npm run check:arch` 全依赖矩阵强制）；Cesium / MapLibre 引用只允许出现在 `infra/`（测试豁免），保证「画廊能加的，球上一定能渲染」。

## 目录结构

```text
src/app/              UI + 组合根：AppShell / LayerPanel / EffectsPanel / GlobeViewer / store
src/controller/       三个控制器（Layer / Camera / Effects），构造器依赖注入，不直接接触 Cesium 或 store
src/service/          ArcGIS 数据入口 + 视口加工：repository / loader / scheduler / http / formats / processing
src/domain/           纯 TS 零依赖：类型 / 契约 / 配置 / 状态机 / 预算 / 几何（被所有层引用）
src/infra/            Cesium / MapLibre 深度封装：cesiumFacade / gpuMemoryManager / 各 provider 适配（唯一深接触点）
src/globe/            渲染编排：globeRenderer、viewport 视口查询与 Primitive
src/styles/           全部样式（直角、深浅主题 CSS 变量）
e2e/                  Playwright 冒烟、UI 与真实 ArcGIS 集成测试
functions/            Cloudflare Pages Functions：/sharing/* 代理 + /api/geo 用户定位
server/               通用 Node 生产服务（proxy.mjs）
.github/workflows/    CI 门禁
```

## 数据源

- **ArcGIS Online 公开资源**：搜索接口 `www.arcgis.com/sharing/rest/search`；公开瓦片服务匿名访问、不消耗 credits


## 更多文档

- [`CLAUDE.md`](CLAUDE.md)：项目真相、架构、设计决策

## 许可证

[MIT License](LICENSE)
