# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 运行阶段：Node 内置 http 托管 dist/ + /sharing ArcGIS 代理 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/proxy.mjs ./server/proxy.mjs
EXPOSE 5173
CMD ["node", "server/proxy.mjs", "5173"]
