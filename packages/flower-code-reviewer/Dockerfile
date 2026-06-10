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
COPY packages/flower-providers/package.json       packages/flower-providers/
COPY packages/flower-tools-common/package.json    packages/flower-tools-common/
COPY packages/flower-tools-gitlab/package.json    packages/flower-tools-gitlab/
COPY packages/flower-compliance/package.json      packages/flower-compliance/
COPY packages/flower-telemetry/package.json       packages/flower-telemetry/
COPY packages/flower-code-reviewer/package.json   packages/flower-code-reviewer/

RUN npm install --no-audit --no-fund

COPY packages/flower-providers       packages/flower-providers
COPY packages/flower-tools-common    packages/flower-tools-common
COPY packages/flower-tools-gitlab    packages/flower-tools-gitlab
COPY packages/flower-compliance      packages/flower-compliance
COPY packages/flower-telemetry       packages/flower-telemetry
COPY packages/flower-code-reviewer   packages/flower-code-reviewer
COPY tsconfig.json                   ./

# 仅 build flower-code-reviewer + 其 transitive deps,
# 避免顶层 tsconfig.json references 其他未 COPY 的 package(flower-tools-arms / flower-ops-bot) 时报 TS5083
RUN npx tsc --build --force packages/flower-code-reviewer/tsconfig.json && \
    chmod +x packages/flower-code-reviewer/dist/cli.js && \
    find packages -path '*/dist/*.d.ts' -delete && \
    find packages -path '*/dist/*.d.ts.map' -delete && \
    find packages -path '*/dist/*.js.map' -delete

# 砍 devDeps(biome / typescript / vitest / tsx 等只在 build 阶段需要),
# 让 runtime 镜像 node_modules 只剩 prod deps,显著减重(预期 ~150MB 节省)
RUN npm prune --omit=dev --no-audit --no-fund && \
    # pi 0.76.0 的 pi-coding-agent 带 npm-shrinkwrap,会在每个 workspace 下重复安装一整套依赖。
    # 运行时只需要一份根级 pi 包;各 workspace 通过 Node 向上查找规则复用 /app/node_modules。
    mkdir -p node_modules/@earendil-works node_modules/@aws-sdk && \
    cp -a -n packages/flower-code-reviewer/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/ && \
    cp -a -n packages/flower-code-reviewer/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/ && \
    cp -a -n packages/flower-code-reviewer/node_modules/@aws-sdk/client-bedrock-runtime node_modules/@aws-sdk/ && \
    rm -rf packages/*/node_modules/@earendil-works/pi-coding-agent \
           packages/*/node_modules/@earendil-works/pi-ai && \
    rm -rf node_modules/@earendil-works/pi-coding-agent/docs \
           node_modules/@earendil-works/pi-coding-agent/examples \
           node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md \
           node_modules/@earendil-works/pi-coding-agent/README.md \
           node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json && \
    find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -iname '*.md' \) -delete && \
    find node_modules -type d \( -iname test -o -iname tests -o -iname __tests__ -o -iname docs -o -iname examples \) -prune -exec rm -rf {} + && \
    # koffi 默认打包 18 个架构 binary,Alpine 容器只需 musl_x64;砍其他 17 个省 ~25MB
    find node_modules/koffi/build/koffi -mindepth 1 -maxdepth 1 ! -name 'musl_x64' -exec rm -rf {} + 2>/dev/null || true

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
COPY --from=builder /build/packages/flower-providers/package.json       ./packages/flower-providers/package.json
COPY --from=builder /build/packages/flower-providers/dist               ./packages/flower-providers/dist
COPY --from=builder /build/packages/flower-tools-common/package.json    ./packages/flower-tools-common/package.json
COPY --from=builder /build/packages/flower-tools-common/dist            ./packages/flower-tools-common/dist
COPY --from=builder /build/packages/flower-tools-gitlab/package.json    ./packages/flower-tools-gitlab/package.json
COPY --from=builder /build/packages/flower-tools-gitlab/dist            ./packages/flower-tools-gitlab/dist
COPY --from=builder /build/packages/flower-compliance/package.json      ./packages/flower-compliance/package.json
COPY --from=builder /build/packages/flower-compliance/dist              ./packages/flower-compliance/dist
COPY --from=builder /build/packages/flower-telemetry/package.json       ./packages/flower-telemetry/package.json
COPY --from=builder /build/packages/flower-telemetry/dist               ./packages/flower-telemetry/dist
COPY --from=builder /build/packages/flower-code-reviewer/package.json   ./packages/flower-code-reviewer/package.json
COPY --from=builder /build/packages/flower-code-reviewer/dist           ./packages/flower-code-reviewer/dist
COPY --from=builder /build/packages/flower-code-reviewer/skills         ./packages/flower-code-reviewer/skills

# PATH 上挂 flower-review wrapper:GitLab CI script 模式不走 ENTRYPOINT,
# 业务方接入模板用 `flower-review --mr-iid $CI_MERGE_REQUEST_IID` 必须能直接调用
RUN printf '#!/bin/sh\nexec node /app/packages/flower-code-reviewer/dist/cli.js "$@"\n' \
      > /usr/local/bin/flower-review && \
    chmod +x /usr/local/bin/flower-review

WORKDIR /workspace

ENTRYPOINT ["node", "/app/packages/flower-code-reviewer/dist/cli.js"]
