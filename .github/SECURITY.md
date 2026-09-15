# 安全策略

## 支持范围

安全修复只针对最新 `main` 分支与当前线上部署（https://earth.gis2all.top）；历史提交与旧的部署快照不再单独维护。

## 报告漏洞

如果你发现安全漏洞（如 XSS、SSRF、敏感信息泄露、依赖高危漏洞等），**请不要在公开 Issue 中披露**。

请通过以下方式私密报告：

- GitHub 仓库的 **Security → Report a vulnerability**（推荐）
- 或邮件联系仓库维护者：`1262057294@qq.com`

## 响应承诺

- 7 天内确认收到报告；
- 确认有效的问题在 30 天内给出修复或缓解方案；
- 修复前不公开漏洞细节，修复合入后统一在发布说明中说明。

## 主要风险面

- **前端依赖与 CSP**：`public/_headers` 是 CSP 的唯一来源（★），当前 `script-src` 含 `'unsafe-eval'` 与 `blob:`、`worker-src` 含 `blob:`——Cesium 与 MapLibre worker 依赖这些能力，收紧前必须单独验证渲染链路。
- **外部数据**：图层来自公开的 ArcGIS Online 服务，站点只做检索与渲染；数据内容本身的问题请向对应数据源方反馈。
- **自托管形态**：生产构建 + Node 代理、Docker 是可选的自托管方式，对外暴露时需自行配置 HTTPS 与访问控制。
- **数据面**：站点没有账号体系，也不在服务端保存用户数据；偏好与本地状态保存在浏览器端。

## 依赖安全

- CI 会对生产依赖执行 `npm audit --omit=dev --audit-level=high`，存在高危漏洞时构建会失败。
- 已知限制：dev 依赖链 vite→esbuild 存在未修复漏洞（需升 Vite 8，属破坏性升级，暂缓），请勿对仓库执行 `npm audit fix --force`。
