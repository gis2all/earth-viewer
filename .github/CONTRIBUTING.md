# 参与贡献

感谢你愿意为 **Earth Viewer** 贡献代码。本仓库是公开项目，欢迎提交 Issue 与 Pull Request。

> 改代码前请先阅读 [`CLAUDE.md`](../CLAUDE.md)——它是项目的唯一权威参考（架构、★不可回退规则、测试与部署、常见任务操作指南）；UI 视觉约束以 [`DESIGN.md`](../DESIGN.md) 为准。

## 报告问题

在 [Issues](https://github.com/gis2all/earth-viewer/issues) 新建 Issue（已提供 Bug 报告与功能建议两个模板），尽量包含：

- **环境**：浏览器及版本、Node 版本、运行方式（本地 dev / Docker / 自托管 Node 代理 / 线上）
- **复现步骤**：打开什么、点哪里、输入什么
- **期望行为** 与 **实际行为**
- **截图 / 控制台报错**（如有）
- 是否是某个特定 ArcGIS 数据源图层触发的（能附上 Web Map 链接最好）

安全问题不要开公开 Issue，请按 [`SECURITY.md`](./SECURITY.md) 私密报告。

## 提交代码

1. 先跑全套验证（必须全绿，与 CI 一致）：
   ```text
   npm ci
   npm run check:arch      # 层间依赖矩阵 + ESLint
   npm run test:coverage   # 覆盖率门槛：statements/lines ≥ 90%
   npm run build
   npm run test:e2e        # 需网络（真实 ArcGIS 集成）
   ```
   CI 还会对生产依赖执行 `npm audit --omit=dev --audit-level=high`。
2. **Commit message 用英文**，按功能分批次提交（不要一次塞大量无关改动）。
3. 改动尽量贴合既有架构：渲染能力判断统一走 `src/domain/layerAssessment.ts`，不要另起一套判定。
4. 遵守 `CLAUDE.md` 中标 ★ 的规则（Cesium 版本锁定、4326 地形、CSP `blob:` 等）。
5. 推送分支并创建 PR，按 [PR 模板](./PULL_REQUEST_TEMPLATE.md) 填写；合入 `main` 后 CI 会重新部署页面与徽章数据。

## 本地开发

```text
npm install
npm run dev        # http://127.0.0.1:5173
```

更多运行与部署方式（生产构建 + Node 代理、Docker、Cloudflare Pages）见 [`CLAUDE.md`](../CLAUDE.md) §3。

## 行为准则

参与本仓库的 Issue、Pull Request 与代码评审时，请遵守[行为准则](./CODE_OF_CONDUCT.md)。
