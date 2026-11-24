# syntax=docker/dockerfile:1.6
# flower-ops-bot 长驻服务镜像

FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/flower-providers/package.json     packages/flower-providers/
COPY apps/ops-bot/package.json       apps/ops-bot/

RUN npm install --no-audit --no-fund

COPY packages/flower-providers     packages/flower-providers
COPY apps/ops-bot       apps/ops-bot

RUN npx tsc --build --force apps/ops-bot/tsconfig.json

# ---------- 运行时镜像 ----------
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages     ./packages
COPY --from=builder /build/apps         ./apps
COPY --from=builder /build/package.json ./

EXPOSE 3000

USER node

CMD ["node", "/app/apps/ops-bot/dist/server.js"]
