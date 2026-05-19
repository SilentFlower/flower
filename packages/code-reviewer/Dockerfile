# syntax=docker/dockerfile:1.6
# code-reviewer 容器镜像
#
# 由 GitLab CI 拉起,跑完即退。
# 仓库代码通过 volume mount 或 git clone 进容器,工作目录为 /workspace。

FROM node:22-alpine AS builder

WORKDIR /build

# 安装 pnpm/npm 依赖时优化缓存
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/pi-providers/package.json     packages/pi-providers/
COPY packages/pi-tools-common/package.json  packages/pi-tools-common/
COPY packages/pi-tools-gitlab/package.json  packages/pi-tools-gitlab/
COPY packages/pi-compliance/package.json    packages/pi-compliance/
COPY packages/code-reviewer/package.json    packages/code-reviewer/

RUN npm install --no-audit --no-fund

COPY packages/pi-providers     packages/pi-providers
COPY packages/pi-tools-common  packages/pi-tools-common
COPY packages/pi-tools-gitlab  packages/pi-tools-gitlab
COPY packages/pi-compliance    packages/pi-compliance
COPY packages/code-reviewer    packages/code-reviewer
COPY tsconfig.json             ./

RUN npm run build

# ---------- 运行时镜像 ----------
FROM node:22-alpine

# git 是评审 agent 需要的(让 LLM 能跑 git log / git diff)
RUN apk add --no-cache git

WORKDIR /app

# 拷贝 builder 阶段的产物 + node_modules
COPY --from=builder /build/node_modules            ./node_modules
COPY --from=builder /build/packages                ./packages
COPY --from=builder /build/package.json            ./

WORKDIR /workspace

ENTRYPOINT ["node", "/app/packages/code-reviewer/dist/cli.js"]
