# syntax=docker/dockerfile:1.6
# flower-ops-bot 长驻服务镜像

FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/flower-tools-common/package.json  packages/flower-tools-common/
COPY packages/flower-tools-arms/package.json    packages/flower-tools-arms/
COPY packages/flower-ops-bot/package.json       packages/flower-ops-bot/

RUN npm install --no-audit --no-fund

COPY packages/flower-tools-common  packages/flower-tools-common
COPY packages/flower-tools-arms    packages/flower-tools-arms
COPY packages/flower-ops-bot       packages/flower-ops-bot
COPY tsconfig.json                 ./

RUN npm run build

# ---------- 运行时镜像 ----------
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages     ./packages
COPY --from=builder /build/package.json ./

EXPOSE 3000

USER node

CMD ["node", "/app/packages/flower-ops-bot/dist/server.js"]
