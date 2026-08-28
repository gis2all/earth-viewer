# REFACTORING.md — Earth Viewer 重构工作计划

> 本文是 refactor 分支的**执行计划**：把 [ARCHITECTURE.md](ARCHITECTURE.md) 的目标架构拆成可执行、可验收的工作包。每步遵循"行为不变、测试全绿"；未授权的 `git add / commit / push` 一律不做。

---

## 0. 执行原则与门禁

- **行为不变**：重构只改结构，不改用户可见行为；每步结束时应用可运行。
- **测试护航**：每步先迁/补测试再改实现；518 单测 + coverage 门禁（statements/lines ≥ 90%）不降；E2E 28 项通过。
- **依赖单向**：只允许外层→内层；除 Infra 外不得 import Cesium/MapLibre；Domain 零依赖。
- **小步提交**：每个工作包独立可验收；commit message 标注 `refactor:`。
- **工作量标注**：S（≤半天）/ M（1 天）/ L（2 天+）。

每步完成统一跑：`npm run lint` → `npm run test:coverage` → `npm run build` → `npm run test:e2e`。

---

## 1. 工作包总览（WBS）

| 编号 | 工作包 | 里程碑 | 工作量 | 前置 |
|---|---|---|---|---|
| W0.1 | 基线记录与验证环境 | M0 前置 | S | — |
| W0.2 | 行为级集成测试（安全网） | M0 前置 | M | W0.1 |
| W0.3 | LayerAdapter 契约测试骨架 | M0 前置 | M | W0.2 |
| W1.1 | LayerKind + LayerAdapter 接口 | M1 Domain ✅ | M | W0.3 |
| W1.2 | LAYER_REGISTRY 注册表 | M1 Domain ✅ | M | W1.1 |
| W1.3 | 图层状态机类型定义 | M1 Domain ✅ | S | W1.1 |
| W1.4 | 预算策略接口 | M1 Domain ✅ | S | W1.1 |
| W2.1 | ArcGISRepository 收口 | M2 Service ✅ | L | W1.x |
| W2.2 | LayerLoader 管线 | M2 Service ✅ | L | W2.1 |
| W2.3 | 请求中间件（超时/429/取消） | M2 Service ✅ | M | W2.1 |
| W3.1 | LayerController（状态机+事件） | M3 Controller ✅ | L | W2.x |
| W3.2 | CameraController 扩展 | M3 Controller ✅ | M | W2.x |
| W3.3 | EffectsController | M3 Controller ✅ | S | W2.x |
| W3.4 | CesiumFacade | M3 Controller ✅ | L | W1.1 |
| W3.5 | GlobeViewer 瘦身 | M3 Controller ✅ | L | W3.1–W3.4 |
| W4.1 | LayerScheduler 统一调度 | M4 横切 ✅ | M | W3.1 |
| W4.2 | 常量收敛与配置驱动 | M4 横切 ✅ | M | W3.5 |
| W4.3 | 死代码清理 | M4 横切 ✅ | S | W4.2 |
| W4.4 | 依赖方向 lint 规则 | M4 横切 ✅ | M | W3.5 |
| W4.5 | 文档同步（架构/上手手册） | M4 横切 ✅ | S | W4.4 |

---

## 2. 详细工作项

### M0 — 前置准备（安全网）

**W0.1 基线记录**

- 跑全套验证，把 lint / coverage / build / E2E 结果记入 `output/`，作为后续每步的对照基线（当前基线：518 单测 / 43 文件，Statements 91.82 / Lines 95.79 / Functions 94.22 / Branches 83.51，见 `output/coverage-w45.log`）。
- 记录 `git status` 干净、refactor 分支起点 commit。

**W0.2 行为级集成测试（最重要）**

- 补"不绑内部结构"的加载链路测试（jsdom + mock fetch，不用真浏览器）：
  - 添加 WebMap → 球上出现 ImageryLayer/DataSource → 卡片变已添加
  - 服务 403/429/超时 → 卡片错误态
  - 移除图层 → 资源销毁、请求 abort
  - 预算超限 → 跳过后续层 + 提示
- 这些测试只依赖"store 状态 + 可观察副作用"，重构期间永不动，是证明"外部没变"的锚点。
- 涉及：新增 `src/test/behavior/` 目录。

**W0.3 契约测试骨架**

- 定义 `LayerAdapter` 契约测试模板：`load 成功返回统一 runtime` / `失败抛统一错误` / `支持 abort` / `estimateRisk 分级正确`。
- 先建骨架与占位实现，M1 完成后接入真实 adapter。
- 涉及：新增 `src/domain/adapter.contract.test.ts`。

### M1 — Domain 立约（零依赖层）

**W1.1 LayerKind + LayerAdapter 接口**（M）

- `domain/types.ts`：`LayerKind` 枚举（map/scene/feature/image/vector/wms/wmts/wfs/kml/geojson/csv/table/document/service 等，对齐现 13 类白名单）。
- `domain/adapter.ts`：`interface LayerAdapter { kind; matches(input): boolean; estimateRisk(input): RiskLevel; load(ctx): Promise<LayerRuntime> }`。
- `domain/runtime.ts`：`LayerRuntime`（imagery[]/ds[]/prim[]/vec[] + dispose()）——替代 GlobeViewer 内联的 layerMapRef 巨型条目类型。
- 涉及：新增 `src/domain/`；不改任何现有调用方（纯新增类型）。

**W1.2 LAYER_REGISTRY 注册表**（M）

- 把 `webmap.ts` 的 8 个 `is*Layer` 判定 + `layerKind` + `providerFor*` 工厂收敛为注册表：`registry.get(kind)` / `registry.matchAll(input)`。
- `webmap.ts` 改为调用注册表，导出别名保持兼容（本步不删旧函数，M3 后再清理）。
- 测试迁移：`webmap.test.ts` 的类型判定用例迁到 `domain/registry.test.ts`；新类型加入只注册 adapter + 契约测试自动覆盖。

**W1.3 图层状态机类型**（S）

- `domain/stateMachine.ts`：`LayerState = pending | preflight | loading | ready | error | cancelled` + 合法转移表 + 状态守卫函数（纯函数，可单测）。
- 现在卡片/错误/added 分散状态后续都以此为准（W3.1 落地实现）。

**W1.4 预算策略接口**（S）

- 从 `loadSafety.ts` 的 `SAFETY` 常量抽出 `BudgetPolicy` 接口与默认实现；`SAFETY` 保留为默认值来源。
- 测试：`domain/policy.test.ts`（含现有 loadSafety.test 迁移）。

### M2 — Service 收口

**✅ M2 已完成（2026-08-29）**

- 验证结果：`npm run lint` 0 错误；`npm run test:coverage` 454 用例全绿，Statements 90.47 / Lines 95.17 / Functions 94.41 / Branches 81.73；`npm run build` 通过。
- 记录：`output/refactor-m2-service.log`。
- 顺手改动：`tsconfig.json` lib 增加 `ES2022.Error`（Error `cause` 需要，仅类型层，不影响 target/产物）。
- 遗留说明（转入 W4.5 backlog）：真实 LayerAdapter 尚未注册到 `LAYER_REGISTRY`（目前仅契约测试引用），`loader.kindOf` 保留"先注册表、无匹配时回退 `layerKindOf`（纯分类）"的回退分支——这是 M2 的已知缺口，删除会破坏 loader 分发与覆盖率，不作为本轮 W4.3 清理项。

**W2.1 ArcGISRepository**（L）

- `service/repository.ts` 收口全部数据访问：
  - search（迁入 LayerPanel 的 `buildSearchQuery`/`mergeSearchResults`/fetch 逻辑与 `SEARCH_*` 常量）
  - item 元数据（迁入预检逻辑：`PREFLIGHT_TYPES`/`readPreflightCache`/`writePreflightCache`）
  - item data / 容器（迁入 `fetchWebmap`）
  - 服务探测（迁入 `detectMapService`/`CRS_CACHE`）
- 缓存统一：预检 24h（现 localStorage）保留行为，`CRS_CACHE` 并入，新增 429 抖动记录。
- LayerPanel 改为调用 Repository；UI 不再直接 fetch。
- 测试迁移：LayerPanel.test.tsx 的搜索/缓存用例迁到 `service/repository.test.ts`。

**W2.2 LayerLoader 管线**（L）

- `service/loader.ts`：预检 → 取数 → 转换 → 预算消费 → 上球，串成管线；按 `LayerKind` 分发到 adapter。
- 收编 `GlobeViewer.renderOperationalLayers` 的**数据与转换部分**（fetch/transform/runViewportProcess/KML→GeoJSON 等）；Cesium 对象创建留在 Infra（W3.4）。
- 测试：`service/loader.test.ts`，用 mock adapter 验证管线顺序、失败、取消、预算跳过。

**W2.3 请求中间件**（M）

- `service/http.ts`：统一超时（现 `withFetchTimeout`）、429 退避（指数退避 + 抖动）、abort 透传、错误归一化。
- Repository/Loader 全部走中间件；删除散落的 `withFetchTimeout` 调用点。
- 测试：`service/http.test.ts`（超时/429/取消三态）。

### M3 — Controller 承接

**✅ M3 已完成（2026-08-29）**

- 验证结果（W3.5 末，`output/test-coverage-w35.log`）：512 用例全绿，Statements 92.00 / Lines 96.01 / Functions 94.49 / Branches 83.61；lint / build / E2E 28 项通过。
- 落地形态：`controller/LayerController`（状态机+领域事件）、`controller/CameraController`、`controller/EffectsController`、`infra/CesiumFacade`；GlobeViewer 913 行瘦身完成，退化为创建 Facade + 订阅控制器 + 转发渲染唤醒。

**W3.1 LayerController**（L）

- `controller/LayerController.ts`：实现 W1.3 状态机 + 领域事件（`subscribe(cb)`，事件：`stateChange`/`ready`/`error`/`removed`）。
- 持有图层运行时表（W1.1 的 `LayerRuntime`），替代 GlobeViewer 的 `layerMapRef` 管理与清理逻辑（abort、viewportController.dispose、cameraMoveHandler 移除）。
- store 的 `added`/`layerErrors` 变为控制器状态的投影（只读视图）。
- 测试：`controller/LayerController.test.ts`——状态流转、事件发布、重复添加/移除竞态、预算消费。

**W3.2 CameraController 扩展**（M）

- `cameraApi.ts` 扩展为 `controller/CameraController`：收编滚轮缓动、双击 zoom、自动环绕 idle 判定、SSE 切换（缩放中 2 → 稳定后 1）、飞行取消。
- 输出"相机状态流"（位置/高度/是否飞行中/SSE），供 ViewportService 与 UI 订阅。
- 测试：现有 cameraApi.test + 新增交互测试（滚轮/双击/环绕）。

**W3.3 EffectsController**（S）

- 把 GlobeViewer 中 effects 变更 → 渲染唤醒/地形/区划网格的副作用迁入 `controller/EffectsController.ts`。
- 测试：EffectsPanel.test 迁移 + 状态变更断言。

**W3.4 CesiumFacade**（L）

- `infra/CesiumFacade.ts`：封装 Viewer 创建、`addImageryLayer`/`addDataSource`/`Primitive`/`3dTiles`/`KmlDataSource`、`requestRender`、地形 provider、销毁。
- 对外只暴露业务语义：`addRuntime(runtime)` / `removeRuntime(id)` / `requestFrame()`。
- GlobeViewer 内的 `requestSceneRender`/`getTerrainProvider` 迁入。
- 测试：`infra/CesiumFacade.test.ts`——mock Cesium，验证封装层调用（这是全项目唯一需要深 mock Cesium 的地方，GlobeViewer.test 的 mock 压力转移到此）。

**W3.5 GlobeViewer 瘦身**（L）

- GlobeViewer 退化为：创建 Facade + 订阅三个 Controller + 转发渲染唤醒。
- 目标：913 行 → ~200 行；删除 `renderOperationalLayers` 巨型分支与内联常量。
- 测试：GlobeViewer.test.tsx 的图层生命周期用例迁出，只留初始化/订阅/渲染唤醒断言。

### M4 — 横切加固

**W4.1 LayerScheduler**（M）

- `service/scheduler.ts`：把现 renderQueue 串行队列升级为"视口优先级 + 串行渲染 + 取消"的统一调度器；Loader 通过 Scheduler 提交任务。
- 测试：`service/scheduler.test.ts`（优先级、串行、取消、并发上限）。

**✅ 已完成**：`service/scheduler.ts` + `service/scheduler.test.ts` 落地，Loader 全量经 Scheduler 提交；验证 520 用例全绿（`output/coverage-w41.log`）。

**W4.2 常量收敛**（M）

- 把 GlobeViewer 顶部常量（SSE/缩放/自动环绕/EVENT_LAYER_MAX 等）、SAFETY、LayerPanel 常量收敛为类型化配置 `domain/config.ts` + `infra/config.defaults.ts`（运行时可覆盖）。
- 主题 token 不动（归 DESIGN.md）。

**✅ 已完成**：`domain/config.ts`（类型化领域配置）+ `infra/config.defaults.ts`（运行时可覆盖默认值）落地；验证 520 用例全绿（`output/coverage-w42.log`）。

**W4.3 死代码清理**（S）

- 删除未消费的 `SCENE_MAX_LOD=15`；清理 M1/M2 遗留的兼容导出别名与 `webmap.ts` 旧判定函数；清理重构后不再引用的工具函数。
- `rg` 验证无未使用导出（配合 `knip` 或人工清单）。

**✅ 已完成**：删除 `SCENE_MAX_LOD=15` 与 `webmap.ts` is*Layer 兼容别名；人工核验后保守保留一批无生产消费方的死导出（applyVectorTileMemoryLimit / toCesiumMvtTemplate / fetchVectorTileTemplates / fetchVectorTileGeoJSON / detectServiceWkid / reprojectFeatureCollection / canStartLoad / degradeReason / createBudgetPolicy / getUserHome / loadLayerData）——删除会破坏层级与覆盖率，记录为 W4.5 backlog 项。验证 518 用例全绿（`output/coverage-w43.log`）。

**W4.4 依赖方向 lint 规则**（M）

- ESLint 加 `no-restricted-imports` / `import/no-restricted-paths`：禁止内层 import 外层、禁止非 Infra import `cesium`/`maplibre-gl`。
- 新增 `npm run check:arch` 脚本（lint + 依赖方向扫描）。

**✅ 已完成**：`git mv` 7 个模块至 `src/globe/facade/`（cameraApi / maplibreImagery / scene / vector / viewpoint / webmap / viewport/primitive），Cesium/MapLibre 引用收敛到 `src/infra/**` 与 `src/globe/facade/**`；新增 `scripts/check-arch.mjs` + `npm run check:arch`（lint + 依赖方向扫描），eslint 用 `no-restricted-imports` 的 `paths` 禁顶层包名（子路径由 check-arch 覆盖，测试豁免）。验证：check:arch OK、518 用例全绿（`output/coverage-w44.log`）、build 通过、E2E 28 项通过（`output/e2e-w44.log`）。

**W4.5 文档同步**（S）

- ARCHITECTURE.md 标记各模块"已落地"；CLAUDE.md 更新结构注释与测试数量；REFACTORING.md 工作包逐项勾选。

**✅ 已完成（2026-08-29）**：ARCHITECTURE.md / CLAUDE.md / REFACTORING.md 三份文档同步至 M4 终态；详见 §5 完成态清单。

---

## 3. 依赖关系与执行顺序

```
W0.1 → W0.2 → W0.3
                ↓
        W1.1 → W1.2 / W1.3 / W1.4（可并行）
                ↓
        W2.1 → W2.2 / W2.3（W2.3 可先行）
                ↓
W3.4(可提前)  → W3.1 / W3.2 / W3.3 → W3.5
                ↓
W4.1 / W4.2 / W4.4（可并行） → W4.3 → W4.5
```

建议推进节奏：每完成一个里程碑（M0–M4）做一次完整验证 + 用户确认，再进入下一个。

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构破坏用户可见行为 | W0.2 行为级测试 + 契约测试兜底；每步全量验证；关键 UI 手测 |
| GlobeViewer 拆分牵一发动全身 | 拆分顺序刻意设计：先抽数据（M2）→ 再抽控制（M3）→ 最后瘦组件（W3.5）；每个中间态都可运行 |
| 测试迁移遗漏导致覆盖率假降 | 迁移清单逐项对照（§2 已列）；每步看 coverage diff 而非只看总数字 |
| `renderOperationalLayers` 巨型 if/else 分支出错 | 该函数数据部分（W2.2）与控制部分（W3.1）分两步抽，每步保持原分支结构不改逻辑 |
| maplibreImagery 误伤 | 该文件纯函数占比高、测试充分（878 行），列为低优先级，只做样式/渲染池分离，不做行为改动 |
| 429/真实服务在重构期干扰 | 所有测试 mock fetch；真实服务只在手动验证 |
| 范围蔓延 | 以本文件 WBS 为界；新想法进 backlog 不进本轮 |

---

## 5. 完成态检查清单（M4 末）

- [x] 除 `infra/` 与 `globe/facade/` 外，`src/` 无 `Cesium.` / MapLibre 直接引用（`npm run check:arch` 通过）
- [x] `rg` 确认无内层 import 外层（依赖方向扫描通过）
- [x] 新增图层类型只需"注册 adapter + 契约测试"，无其他改动（以文档步骤验证）
- [x] 卡片状态、球体渲染由同一状态机驱动（无分散 if/else 状态判断）
- [x] 无散落 fetch（全部走 Repository + 中间件）
- [x] 518 单测（新测试计入）、coverage ≥ 90%、E2E 28 项、lint/build 通过
- [x] ARCHITECTURE.md 标记落地，CLAUDE.md 无漂移
- [x] 死代码清理完成，`SCENE_MAX_LOD` 等已删除

**遗留 backlog（不阻塞完成态，记录在案）**：

- M2 缺口：`LAYER_REGISTRY` 尚无真实 adapter（仅契约测试引用），`loader.kindOf` 保留 `layerKindOf` 回退分支；后续新增真实 adapter 并注册后，回退分支才可删除。
- 保守保留的死导出清单见 W4.3（删除会破坏层级/覆盖率，待引入 knip 或明确消费方后处理）。
