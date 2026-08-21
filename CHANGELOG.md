# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式。

## [0.1.0] - 2026-08-21

### 新增
- CesiumJS 1.144 3D 地球渲染（4326 底图/地形，两极无空白）
- ArcGIS Online 数据源画廊：搜索、预取、统一渲染能力评估、按浏览数降序、按批流式上屏
- 多投影自动探测（EPSG:4326 / Web Mercator）
- 图层管理：增量加载/移除、能力角标、加载失败红标、状态持久化
- 效果面板：大气散射、星空、日月、雾效、昼夜光照、地形透明、地形夸张
- 相机：回正/复位、自动环绕（东西向）、右键倾斜、滚轮平滑缩放、双击放大
- 深浅色双主题、品牌图标与 favicon 跟随主题
- 质量门禁：覆盖率门槛（statements/lines ≥ 90%）、Playwright E2E、GitHub Actions CI
- Docker 运行（两阶段镜像，端口统一 5173）
- Cloudflare Pages 部署（`wrangler.toml`、`_headers`/`_redirects`、自定义域名 https://earth.gis2all.top）
- README 产品图标与压缩截图、徽章体系（Coverage / Deps / Tests / E2E）
- CLAUDE.md 重写为 Agent 上手手册（30 秒速览 + 任务式操作指南）
- 社区文件：CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / PR 与 Issue 模板

### 修复
- 画廊无限滚动 items 重复膨胀（onBatch 误用累积 pageAcc 追加）
- 无输入内容时搜索取消按钮不显示
