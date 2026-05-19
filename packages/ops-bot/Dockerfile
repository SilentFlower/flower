# syntax=docker/dockerfile:1.6
# ops-bot 长驻服务镜像

FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/pi-tools-common/package.json packages/pi-tools-common/
COPY packages/pi-tools-arms/package.json   packages/pi-tools-arms/
COPY packages/ops-bot/package.json         packages/ops-bot/

RUN npm install --no-audit --no-fund

COPY packages/pi-tools-common  packages/pi-tools-common
COPY packages/pi-tools-arms    packages/pi-tools-arms
COPY packages/ops-bot          packages/ops-bot
COPY tsconfig.json             ./

RUN npm run build

# ---------- 运行时镜像 ----------
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages     ./packages
COPY --from=builder /build/package.json ./

EXPOSE 3000

USER node

CMD ["node", "/app/packages/ops-bot/dist/server.js"]
