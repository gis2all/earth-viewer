# 安全策略

## 报告漏洞

如果你发现安全漏洞（如 XSS、SSRF、敏感信息泄露、依赖高危漏洞等），**请不要在公开 Issue 中披露**。

请通过以下方式私密报告：

- GitHub 仓库的 **Security → Report a vulnerability**（推荐）
- 或邮件联系仓库维护者（见仓库主页）

## 处理流程

- 确认后我们会在修复后统一发布说明
- 修复前不会公开漏洞细节

## 依赖安全

- CI 会对生产依赖执行 `npm audit --omit=dev --audit-level=high`，存在高危漏洞时构建会失败。
- 已知限制：dev 依赖链 vite→esbuild 存在未修复漏洞（需升 Vite 8，属破坏性升级，暂缓），请勿对仓库执行 `npm audit fix --force`。
