# ARCHITECTURE.md — Earth Viewer 架构（已落地）

> 本文描述 Earth Viewer 的目标架构。M0–M4 重构已于 2026-08-29 全部落地（见 [REFACTORING.md](REFACTORING.md)），当前代码以此为准；与代码冲突时，先确认哪一方代表最新已确认设计，再同步另一方。

---

## 0. 速览

- **目标**：高内聚、低耦合。加一种图层类型、改一个数据源、加一个视口策略，都不需要触碰 `GlobeViewer` 与 `LayerPanel`。
- **核心手段**：五层单向依赖 + GIS 通用设计模式（适配器/状态机/仓储/外观/调度器）。
- **最终形态**：相机走命令+观察者，图层走状态机+领域事件，数据源走仓储+中间件，渲染走外观+适配器+调度器——每一对都是"一个入口、多个消费者、单向依赖"。
- **验收底线**：每一步重构行为不变、518 单测全绿、覆盖率门禁不降、E2E 通过。

**★ 不可违反规则**：
1. 依赖只能外层→内层，反向禁止；`Domain` 零依赖（纯 TS 类型与规则，不 import Cesium/React/fetch）。
2. 全项目除 `Infra` 层与 `globe/facade/` 适配器外，不得出现 `Cesium.` / MapLibre 直接引用（`npm run check:arch` 强制）。
3. 图层生命周期由唯一状态机驱动，禁止在卡片 UI、store、球体渲染三处各维护一份状态。
4. ArcGIS 请求与缓存一律收口 `ArcGISRepository`，禁止散落 fetch。

---

## 1. 现状诊断（重构前，已解决）

重构前代码整体质量良好（模块划分清晰、338 单测、覆盖率 90%+），但三个热点文件承担了过多职责；以下病灶已在 M0–M4 中逐一解决：

| 文件 | 行数 | 问题 |
|---|---|---|
| `src/globe/GlobeViewer.tsx` | 913 | 上帝组件：同时是 Cesium Facade、相机控制器、图层生命周期管理器、状态持有者 |
| `src/app/LayerPanel.tsx` | 715 | UI 与业务混合：图标组件、搜索逻辑、预检缓存、缩略图超时全内联 |
| `src/globe/maplibreImagery.ts` | 771 | 样式解析与渲染池混合 |

核心病灶：

- **类型分支散落**：8 个 `is*Layer` 判定 + `providerFor*` 工厂分布在 `webmap.ts`，新增类型要改多处。
- **图层状态多处分散**：卡片按钮状态、store 的 `added`、错误标记、球体上的实际图层各自维护，缺乏唯一状态源。
- **请求与缓存逻辑散落**：超时、429 退避、预检缓存、LRU 各写各的，UI 直接碰 fetch。
- **死代码候选**：`SAFETY.SCENE_MAX_LOD=15` 未被消费，重构时一并处理。

---

## 2. 目标分层

```
┌──────────────────────────────────────────────────────────────┐
│ Presentation 组件层（只渲染 + 转发意图，不碰 Cesium/fetch）     │
│   AppShell · LayerPanel · EffectsPanel · GlobeViewer(瘦 Facade)│
└───────────────▲──────────────────────────────────────────────┘
                │ 用户意图（命令）
┌───────────────┴──────────────────────────────────────────────┐
│ Controller 控制层（命令 + 状态机 + 领域事件）                  │
│   CameraController · LayerController · EffectsController      │
└───────────────▲──────────────────────────────────────────────┘
                │ 用例编排（调用服务）
┌───────────────┴──────────────────────────────────────────────┐
│ Service 服务层（编排 + 横切中间件）                            │
│   ArcGISRepository · LayerLoader · ViewportService           │
│   LayerScheduler · BudgetManager                             │
└───────────────▲──────────────────────────────────────────────┘
                │ 依赖抽象接口（依赖倒置）
┌───────────────┴──────────────────────────────────────────────┐
│ Domain 领域层（纯 TS 类型与规则，零框架依赖）                  │
│   LayerKind · LayerAdapter 接口 · 状态机定义 · 预算策略       │
└───────────────▲──────────────────────────────────────────────┘
                │ 实现领域接口
┌───────────────┴──────────────────────────────────────────────┐
│ Infra 基础设施层（唯一允许 import Cesium/MapLibre 的地方）     │
│   CesiumFacade · MapLibrePool · Cache · Http · Worker · Store │
└──────────────────────────────────────────────────────────────┘
```

依赖铁律：**外层依赖内层，反向禁止**。`Domain` 在最中心且零依赖——只定义"图层有什么类型、加载有哪些状态、预算怎么算"，不关心 Cesium 是什么。`Infra` 实现 `Domain` 的接口，`Service` 面向接口编程——将来换渲染引擎（如 MapLibre GL 3D）只动 `Infra`。

---

## 3. 模块边界与模式映射

| 目标模块 | 设计模式 | 现有雏形 | 迁移动作 |
|---|---|---|---|
| `controller/CameraController` | Command + Observer | `cameraApi.ts` | 收编滚轮/双击/自动环绕，输出相机状态流 ✅ 已落地（`src/controller/CameraController.ts`） |
| `controller/LayerController` | State Machine + Domain Events | store.added + layerErrors（分散） | 收敛图层生命周期为唯一状态机 ✅ 已落地（`src/controller/LayerController.ts`） |
| `service/ArcGISRepository` | Repository + Middleware | webmap.ts fetch + LayerPanel 预检缓存 | 收口 search/元数据/data/探测，内挂超时/429/缓存 ✅ 已落地（`src/service/repository.ts`） |
| `domain/LayerAdapter` 注册表 | Strategy / Plugin | `is*Layer` + `providerFor*` | 统一为接口 + 注册表，新增类型只加 adapter ✅ 已落地（`src/domain/registry.ts`，adapter 留 M2 backlog） |
| `service/LayerLoader` | Pipeline | 散在 GlobeViewer 内 | 预检→取数→转换→上球串成管线 ✅ 已落地（`src/service/loader.ts`） |
| `service/ViewportService` | Layer/LayerView 单向流 | `viewport/` 目录 | 生命周期交给控制器，保留现管线 ✅ 已落地（`src/globe/viewport/` + `renderWebmap.ts`） |
| `service/LayerScheduler` | Scheduler | `renderQueue` + LRU | 视口优先级 + 串行队列 + 取消统一 ✅ 已落地（`src/service/scheduler.ts`） |
| `infra/CesiumFacade` | Facade | GlobeViewer.tsx（过胖） | 对外只暴露业务语义，项目内不散见 `Cesium.` ✅ 已落地（`src/infra/CesiumFacade.ts`） |
| `infra/MapLibrePool` | 资源池 | maplibreImagery.ts | 样式解析与渲染池分离 ✅ 已落地（`src/globe/facade/maplibreImagery.ts`） |
| `state/Store` | 状态容器 | store.ts | 只存全局态，图层运行时状态迁入控制器 ✅ 已落地（`src/state/store.ts`） |

目标目录布局（迁移后现状）：

```
src/
  app/          # Presentation：AppShell / LayerPanel / EffectsPanel（瘦）
  globe/        # 渲染实现：GlobeViewer（瘦）+ viewport 管线 + facade/（Cesium/MapLibre 适配）
    facade/     # ★渲染引擎适配层：cameraApi / maplibreImagery / scene / vector / viewpoint / webmap / primitive
  controller/   # CameraController / LayerController / EffectsController
  service/      # repository / loader / viewport / scheduler / http（中间件）
  domain/       # types / registry / state-machine / policy / config（纯 TS，零依赖）
  state/        # zustand store（持久化）
  infra/        # CesiumFacade / config.defaults
```

---

## 4. 关键数据流

### 4.1 添加图层（主链路）

```
LayerPanel 点击添加
 └─ LayerController.add(item)               命令
    ├─ 状态机: pending → preflight → loading
    ├─ Repository.preflight(item)           中间件: 3s 超时/缓存 24h/429 退避
    ├─ LayerLoader.load(item)               管线
    │   ├─ 注册表按 kind 分发到具体 Adapter
    │   ├─ BudgetManager 消费要素/顶点预算
    │   └─ Scheduler 排队 → CesiumFacade.addLayer(runtime)
    └─ 领域事件: layer.ready                ← 观察者
        ├─ LayerPanel 刷新卡片（订阅）
        └─ GlobeViewer 请求一帧（订阅）
```

### 4.2 相机飞行（联动链路）

```
滚轮/双击/复位按钮
 └─ CameraController.flyTo(ext)             命令 + 动画编排
    └─ 相机状态流更新                       Observer
        ├─ ViewportService: moveEnd → 视口查询 → LRU → 渲染
        ├─ SSE 切换: 缩放中 2 → 稳定后 1
        └─ AutoRotate: 空闲 3s 判定
```

---

## 5. 落地路线图

按依赖方向推进，每步结束时应用行为不变、可运行：

### M1 — Domain 立约（低风险，先行）✅

- 定义 `LayerKind`、`LayerAdapter` 接口、图层状态机类型、预算策略接口
- 建 `LAYER_REGISTRY`，把 `webmap.ts` 的类型判定与 provider 工厂迁入
- 验收：行为不变，测试全绿，新增类型只需注册 adapter 的骨架可见

### M2 — Service 收口 ✅

- `ArcGISRepository` 收编 search / item 元数据 / item data / 服务探测与全部缓存
- `LayerLoader` 把预检→取数→转换→上球串成管线
- 中间件统一：超时、429 退避、取消
- 验收：UI 与控制器不再直接碰 fetch；预检缓存从 LayerPanel 迁出

### M3 — Controller 承接 ✅

- 图层生命周期从 GlobeViewer 迁入 `LayerController`（状态机 + 领域事件）
- `CameraController` 收编相机交互与命令
- GlobeViewer 退化为瘦 Facade，仅保留 Cesium 初始化与渲染唤醒
- 验收：除 Infra 外无 `Cesium.` 引用；卡片状态与球体渲染由同一状态机驱动

### M4 — 横切加固 ✅

- `LayerScheduler` 统一视口优先级、串行队列、取消
- 清理死代码（`SCENE_MAX_LOD=15`）、常量收敛、配置驱动
- 验收：全局检查通过，无反向依赖，覆盖率门禁保持

---

## 6. 迁移映射（现状 → 目标）

| 现状 | 目标 |
|---|---|
| `src/globe/GlobeViewer.tsx`（913 行） | ✅ → `infra/CesiumFacade` + `controller/*`（Camera/Layer/Effects）+ `globe/facade/` |
| `src/app/LayerPanel.tsx`（715 行） | ✅ → 瘦组件 + `service/ArcGISRepository` + `service/loader` |
| `src/globe/webmap.ts` | ✅ → `globe/facade/webmap.ts` + `domain/registry` + `service/repository` |
| `src/globe/maplibreImagery.ts` | ✅ → `globe/facade/maplibreImagery.ts`（MapLibre 池保留） |
| `src/globe/cameraApi.ts` | ✅ → `controller/CameraController`（facade 保留初始化/命令转发） |
| `src/globe/viewport/` | ✅ → `globe/viewport/`（保留现管线，生命周期交 LayerController） |
| `src/globe/loadSafety.ts` | ✅ → `domain/policy` + `domain/config` |
| `src/state/store.ts` | ✅ → 只存全局态（theme/added 摘要/效果），运行时状态迁入控制器 |

---

## 7. 验证门禁

- `npm run lint`
- `npm run test:coverage`：518 单测，statements/lines ≥ 90%（2026-08-29 实测 Statements 91.18 / Lines 95.11 / Functions 94.09 / Branches 82.93）
- `npm run check:arch`：依赖方向扫描（Cesium/MapLibre 仅限 `infra/` 与 `globe/facade/`）
- `npm run build`
- `npm run test:e2e`：28 项
- `rg` / `check:arch` 检查：`src/` 中除 `infra/` 与 `globe/facade/` 外无 `Cesium.` 直接引用；无反向 import（内层不得 import 外层）
- `git diff --check`
