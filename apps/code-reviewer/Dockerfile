# syntax=docker/dockerfile:1.6
# flower-code-reviewer 容器镜像
#
# 由 GitLab CI 拉起,跑完即退。
# 仓库代码通过 volume mount 或 git clone 进容器,工作目录为 /workspace。

FROM node:22-alpine AS builder

WORKDIR /build

# 安装 pnpm/npm 依赖时优化缓存
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/flower-providers/package.json       packages/flower-providers/
COPY packages/flower-tools-gitlab/package.json    packages/flower-tools-gitlab/
COPY packages/flower-compliance/package.json      packages/flower-compliance/
COPY packages/flower-telemetry/package.json       packages/flower-telemetry/
COPY apps/code-reviewer/package.json   apps/code-reviewer/

RUN npm install --no-audit --no-fund

COPY packages/flower-providers       packages/flower-providers
COPY packages/flower-tools-gitlab    packages/flower-tools-gitlab
COPY packages/flower-compliance      packages/flower-compliance
COPY packages/flower-telemetry       packages/flower-telemetry
COPY packages/agent-runtime          packages/agent-runtime
COPY apps/code-reviewer   apps/code-reviewer
COPY tsconfig.json                   ./

# 仅 build flower-code-reviewer + 其 transitive deps,
# 避免根 tsconfig.json 引用未复制的应用或包时出现 TS5083。
RUN npx tsc --build --force apps/code-reviewer/tsconfig.json && \
    chmod +x apps/code-reviewer/dist/cli.js && \
    find apps packages -path '*/dist/*.d.ts' -delete && \
    find apps packages -path '*/dist/*.d.ts.map' -delete && \
    find apps packages -path '*/dist/*.js.map' -delete

# 保留 npm 的依赖布局和动态加载所需的文件，包括 coding-agent 的嵌套依赖与 WASM。
RUN npm prune --omit=dev --no-audit --no-fund

# 裁剪后从工作区实际入口确认 pi 和工具 schema 构造器仍可解析。
RUN (cd apps/code-reviewer && node -e "Promise.all([import('@flower-ai/agent-runtime'),import('@earendil-works/pi-coding-agent'),import('typebox'),import('undici')])") && \
    (cd packages/flower-tools-gitlab && node -e "Promise.all([import('@earendil-works/pi-coding-agent'),import('typebox')])") && \
    (cd packages/flower-providers && node -e "Promise.all([import('@earendil-works/pi-ai'),import('@earendil-works/pi-coding-agent')])")

# ---------- 运行时镜像 ----------
FROM node:22-alpine

# 评审 agent 需要的命令行工具:
# - git:LLM 跑 git log / git diff / git blame
# - ripgrep(rg):比 grep 快 + 自动跳 .gitignore,LLM 在大仓库内搜索时省 token
RUN apk add --no-cache git ripgrep

WORKDIR /app

# 拷贝 builder 阶段的产物 + node_modules
COPY --from=builder /build/node_modules            ./node_modules
COPY --from=builder /build/package.json            ./
COPY --from=builder /build/packages/agent-runtime/package.json         ./packages/agent-runtime/package.json
COPY --from=builder /build/packages/agent-runtime/dist                 ./packages/agent-runtime/dist
COPY --from=builder /build/packages/flower-providers/package.json       ./packages/flower-providers/package.json
COPY --from=builder /build/packages/flower-providers/dist               ./packages/flower-providers/dist
COPY --from=builder /build/packages/flower-tools-gitlab/package.json    ./packages/flower-tools-gitlab/package.json
COPY --from=builder /build/packages/flower-tools-gitlab/dist            ./packages/flower-tools-gitlab/dist
COPY --from=builder /build/packages/flower-compliance/package.json      ./packages/flower-compliance/package.json
COPY --from=builder /build/packages/flower-compliance/dist              ./packages/flower-compliance/dist
COPY --from=builder /build/packages/flower-telemetry/package.json       ./packages/flower-telemetry/package.json
COPY --from=builder /build/packages/flower-telemetry/dist               ./packages/flower-telemetry/dist
COPY --from=builder /build/apps/code-reviewer/package.json   ./apps/code-reviewer/package.json
COPY --from=builder /build/apps/code-reviewer/dist           ./apps/code-reviewer/dist
COPY --from=builder /build/apps/code-reviewer/skills         ./apps/code-reviewer/skills

# PATH 上挂 flower-review wrapper:GitLab CI script 模式不走 ENTRYPOINT,
# 业务方接入模板用 `flower-review --mr-iid $CI_MERGE_REQUEST_IID` 必须能直接调用
RUN printf '#!/bin/sh\nexec node /app/apps/code-reviewer/dist/cli.js "$@"\n' \
      > /usr/local/bin/flower-review && \
    chmod +x /usr/local/bin/flower-review

WORKDIR /workspace

ENTRYPOINT ["node", "/app/apps/code-reviewer/dist/cli.js"]
