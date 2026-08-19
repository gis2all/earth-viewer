# EarthViz · 3D 地球数据可视化 Web App 设计

> 日期：2026-08-19 · 状态：已确认 · 作者：gis2all

## 1. 产品概述

EarthViz 是一个**展厅型（showcase）3D 地球数据可视化 Web 应用**：以 CesiumJS 3D 地球为绝对主角，内置五类精选数据，用户像逛画廊一样切换数据图层、拖动时间轴看动态数据。纯前端、可静态部署，无账号、无上传。

## 2. 范围（v1）

| 数据分类 | v1 数据集 |
|---|---|
| 地形 | GEBCO / SRTM 高程 + 高程色阶 + 地形阴影 |
| 影像 | Blue Marble 卫星影像 / 夜间灯光 |
| 人文 | Natural Earth 行政边界（凸起）、城市点位 |
| 环境 | ESA 土地利用分类 |
| 气象 | 台风/气温时序（时间轴播放） |
| 地质 | USGS 地震 + 板块边界 |

**核心交互**：左侧可折叠面板内「画板」式图层卡片（基底·单选 / 叠加·多选），点击应用；底部时间轴只在点亮时序图层（气象/地震）时按需出现；白天/深色双主题；相机预设。

## 3. 技术栈

- **React 18 + Vite + TypeScript**
- **CesiumJS + resium**（3D 地球主引擎）
- **Zustand**（状态管理：图层、主题、时间、相机预设）
- 部署：Cloudflare Pages / Vercel（静态构建）

## 4. 架构（目录结构）

```
earth-viz-hub/
├─ src/
│  ├─ app/        UI 壳：布局 / 侧栏 / 工具栏 / 时间轴
│  ├─ globe/      Cesium 封装：GlobeViewer 组件 / 相机预设 / 事件
│  ├─ layers/     图层系统：统一 Layer 接口 + 各数据图层
│  ├─ data/       数据目录 catalog.ts + loaders（GeoJSON/影像/地形/时序）
│  ├─ state/      Zustand store（layers / theme / time / camera）
│  ├─ styles/     主题设计系统（CSS 变量：白天/深色）
│  └─ hooks/      复用 hooks（useGlobe / useTimeline / useTheme）
├─ public/data/   T1 小样本（边界 GeoJSON / 地震 / 城市点）
├─ docs/          数据目录 + 接入指南
└─ deploy/        部署配置
```

**核心抽象：统一 Layer 接口**

```ts
interface Layer {
  id: string;
  name: string;
  category: 'base' | 'overlay';
  group: 'terrain' | 'human' | 'environment' | 'weather' | 'geology';
  type: 'terrain' | 'imagery' | 'geojson' | 'raster' | 'timeseries';
  activate(ctx: GlobeContext): void;
  deactivate(ctx: GlobeContext): void;
  update(ctx: GlobeContext, state: AppState): void; // 时间轴/透明度驱动
}
```

## 5. UI 设计方向（已确认）

- **风格**：Linear 式深色极简（近黑底 + 靛紫强调），白天/深色双主题
- **全直角**：卡片/按钮/面板全部 0 圆角
- **字体**：系统无衬线（苹方/微软雅黑），数据读数用等宽
- **图层面板**：左侧可折叠，「画板」式单层直角卡片（SVG 缩略图 + 名称，基底·单选 / 叠加·多选）
- **时间轴**：仅在时序图层激活时按需出现
- **图标**：细线 SVG，禁用 emoji
- 不追求与原型逐像素一致，以设计方向为准

## 6. 数据策略

- **T1 进仓库**：Natural Earth 边界、USGS 地震、城市点位、小样本（几十 MB 内）
- **T2 远程引用**：Blue Marble、GEBCO/SRTM 高程瓦片、底图、WorldPop（在线服务）
- **T3 脚本生成**：Python 下载 → 预处理 → 托管 CDN/R2（大文件不进仓库）

## 7. v1 里程碑

1. 工程骨架（Vite + TS + Cesium + 主题 + 布局）
2. 图层系统 + 画板面板（基底/叠加、开关、折叠）
3. 首批图层：地形（DEM+色阶）、影像（Blue Marble/夜光）、边界（凸起）
4. 时序图层 + 按需时间轴（气象/地震）
5. 相机预设 + 白天/深色打磨
6. 部署上线（Cloudflare Pages）

## 8. 非目标（v1 不做）

- 用户上传数据、账号系统、后端
- MapLibre / 2D 渲染
- Unity/Unreal 客户端（仅文档）
- 卫星/太空数据（后续版本）
