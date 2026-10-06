# 构建阶段: 编译 better-sqlite3 原生模块
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# 运行阶段
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000

# 启动入口由 Compose 覆盖为: 先建库再起服务
CMD ["node", "server.js"]
