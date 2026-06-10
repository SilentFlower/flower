# syntax=docker/dockerfile:1.6
# flower-observer 常驻观测服务镜像
#
# 形态对齐 flower-ops-bot(server.ts / node dist 常驻);SQLite 单文件挂 volume。

FROM node:22-alpine AS builder

WORKDIR /build

# 先 COPY manifest 利用层缓存
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/flower-telemetry/package.json packages/flower-telemetry/
COPY packages/flower-observer/package.json  packages/flower-observer/

RUN npm install --no-audit --no-fund

COPY packages/flower-telemetry packages/flower-telemetry
COPY packages/flower-observer  packages/flower-observer

# 仅 build observer + 其传递依赖(telemetry),避免根 tsconfig references
# 其他未 COPY 的 package 时报 TS5083(同 flower-code-reviewer 的处理)
RUN npx tsc --build --force packages/flower-observer/tsconfig.json && \
    cp -r packages/flower-observer/src/static packages/flower-observer/dist/static && \
    # 砍 devDeps(typescript / vitest / tsx 仅 build 期需要)
    npm prune --omit=dev --no-audit --no-fund && \
    # @flower-ai/flower-telemetry 仅提供编译期类型(dist 全部 import type,产物零运行时引用),
    # 不随镜像携带——其传递依赖 @earendil-works/pi-coding-agent 体积大且 observer 用不到
    rm -rf node_modules/@flower-ai node_modules/@earendil-works

# ---------- 运行时镜像 ----------
FROM node:22-alpine

# tzdata:指标页「按天」聚合按本地时区分界(alpine 基础镜像不带时区数据)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
COPY --from=builder /build/packages/flower-observer/package.json ./packages/flower-observer/package.json
COPY --from=builder /build/packages/flower-observer/dist         ./packages/flower-observer/dist

# SQLite 数据目录(volume 挂载点);node 用户需写权限
ENV OBSERVER_DB_PATH=/app/data/observer.db
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

EXPOSE 4810

USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "/app/packages/flower-observer/dist/server.js"]
