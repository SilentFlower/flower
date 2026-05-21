# Implementation Plan · flower-providers env 缺省 fallback

> 三件套之 implement.md。基于 `prd.md` R1-R6 + `design.md` §1-§4。

## 总体顺序

```
Phase 1 · 实施前 spike:curl havefun 网关确认 havefun-anthropic + sonnet-4-6 可用   (~10 min)
Phase 2 · 加常量 + helper(env.ts) + 单测 5 case                              (~30 min)
Phase 3 · 改 buildPiCliArgs + 单测 4 case                                       (~20 min)
Phase 4 · 整套质量门(typecheck + lint + 全单测)                              (~10 min)
Phase 5 · README + spec 同步                                                    (~15 min)
Phase 6 · e2e:在 pineapple MR-2 跑一次"故意不配 env"的评审验证               (~10 min)
Phase 7 · commit + archive                                                       (~10 min)
```

工作量预估:**≈ 1.5 小时**。

---

## Phase 1 · spike · 默认值可用性确认

**目的**:在改代码前用 curl 确认 havefun 网关确实开通了 anthropic 协议 + `claude-sonnet-4-6` model id 可用。

**Checklist**:
- [ ] 1.1 拿到 `LLM_BASE_URL` + `LLM_API_KEY`(从 pineapple Project Variables 借用,或问 ops)
- [ ] 1.2 `curl "$LLM_BASE_URL/v1/models" -H "Authorization: Bearer $LLM_API_KEY" | grep claude-sonnet-4-6` → 应返回 200 且含该 model
- [ ] 1.3 真打一次 `POST $LLM_BASE_URL/v1/messages`(anthropic 协议)发一句 "ping" → 200 + 正常 reply
- [ ] 1.4 若失败 → **回 PRD 调整 DEFAULT_*** 值(可能改成 `havefun-openai-responses + gpt-5.5` 兜底)

**Review gate**:默认值在网关侧确认可用,再进 Phase 2。

---

## Phase 2 · env.ts 加常量 + helper + 单测

**目的**:落地 design.md §1.2 的 `OrDefault` 变体 + 默认常量。

**Checklist**:
- [ ] 2.1 `packages/flower-providers/src/env.ts` 顶部(`ALLOWED_REASONING_EFFORTS` 附近)新增 `export const DEFAULT_LLM_PROVIDER: ProviderName = "havefun-anthropic"`
- [ ] 2.2 同位置新增 `export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6"`
- [ ] 2.3 在 `getLLMProvider` 函数下方新增 `getLLMProviderOrDefault(): ProviderName`(实现见 design.md §1.2)
- [ ] 2.4 在 `getLLMModel` 函数下方新增 `getLLMModelOrDefault(): string`(同上)
- [ ] 2.5 `packages/flower-providers/src/__tests__/env.test.ts` 加 5 个 case(AC1.1-1.5):
  - provider 不配 → default
  - provider 合法 → 透传
  - provider 非法值 → throw
  - model 不配 → default
  - model 任意非空 → 透传

**验证**:
```bash
cd packages/flower-providers && pnpm vitest run env.test
```

**Review gate**:helper 不破坏现有 `getLLMProvider` / `getLLMModel` 的 throw 契约;新 case 全绿;现有 case 不被改动。

---

## Phase 3 · runtime.ts 改 buildPiCliArgs + 单测

**目的**:落地 design.md §1.3 的修改。

**Checklist**:
- [ ] 3.1 `packages/flower-providers/src/runtime.ts` 顶部 import 加 `getLLMProviderOrDefault, getLLMModelOrDefault`(从 env.ts)
- [ ] 3.2 重写 `buildPiCliArgs` 内的 provider/model 处理:
  - 调用 OrDefault helper 拿值
  - **缺 env 时**额外 `console.log("[flower-providers] LLM_X 未配置,fallback 到 \"<value>\"")`
  - 永远 push `["--provider", X, "--model", Y]`(不再有"argv 不附加 --model" 这条路径)
- [ ] 3.3 `packages/flower-providers/src/__tests__/runtime.test.ts` 加 4 个 case(AC1.6-1.9):
  - 都不配 → argv 含 default provider + default model
  - 只配 model → default provider + 用户 model
  - 都配 → 用户 provider + 用户 model
  - 缺省 fallback 时 console.log 被调用(用 `vi.spyOn(console, "log")`)

**验证**:
```bash
cd packages/flower-providers && pnpm vitest run runtime.test
```

**Review gate**:`console.log` mock 检查到合理日志;argv 顺序与原有 case(`["--provider", X, "--model", Y]`)对齐。

---

## Phase 4 · 整套质量门

**目的**:确保改动不破坏全局。

**Checklist**:
- [ ] 4.1 `pnpm -r typecheck`
- [ ] 4.2 `pnpm -r lint`
- [ ] 4.3 `pnpm -r test`(应当从 149 → 158 单测,全绿)
- [ ] 4.4 `git diff --stat` 确认只动 4 文件:env.ts、runtime.ts、env.test.ts、runtime.test.ts

---

## Phase 5 · README + spec 同步

**目的**:文档与代码同步。

**Checklist**:
- [ ] 5.1 `packages/flower-providers/README.md` env 表 / 关键设计点:加 fallback 注释(prd.md R6 措辞)
- [ ] 5.2 `.trellis/spec/flower-providers/backend/index.md` 新增一节"CLI 路径 vs SDK 路径的缺省语义",对比两条入口:
  - **CLI**(`buildPiCliArgs`):env 缺省 → fallback 到默认(降低接入门槛)
  - **SDK**(`getDefaultModel`):env 缺省 → throw(显式配置,服务常驻)
  - 设计取向:CI 工具开放,服务严格

**Review gate**:spec 措辞清晰,不破坏现有目录结构(index.md 章节序号自然递增)。

---

## Phase 6 · e2e:pineapple MR-2 验证

**目的**:落地 AC2,在真实业务方仓里验证 fallback 生效 + 走 havefun 网关。

**Checklist**:
- [ ] 6.1 flower 本仓 commit + push,触发镜像 build pipeline,等新 image tag
- [ ] 6.2 在 pineapple `.gitlab-ci.yml` 锁 `FLOWER_IMAGE_TAG: <new-sha>`(或滚到 latest)
- [ ] 6.3 **删除**当前 .gitlab-ci.yml 中的 `LLM_PROVIDER` / `LLM_MODEL` variables(显式测试缺省路径)
- [ ] 6.4 push 空 commit / retry pipeline
- [ ] 6.5 job trace 应当:
  - 看到 `[flower-providers] LLM_PROVIDER 未配置,fallback 到 "havefun-anthropic"` 日志
  - 看到 `[flower-providers] LLM_MODEL 未配置,fallback 到 "claude-sonnet-4-6"` 日志
  - LLM 调用走 havefun 网关(SIEM / 网络日志侧确认 endpoint host)

**Review gate**:fallback 日志真实出现 + LLM 真在网关 baseUrl 上有调用记录。

---

## Phase 7 · commit + archive

**Checklist**:
- [ ] 7.1 `git add -A && git commit -m "feat(flower-providers): code-reviewer CLI 路径在 env 缺省时 fallback 到 havefun-anthropic + sonnet-4-6"`
- [ ] 7.2 `task.py archive`
- [ ] 7.3 (可选)在 journal 写 1 行小结

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 spike 失败 | 改 PRD 默认值选择(如 sonnet → opus 或 gpt-5.5),不进 Phase 2 |
| Phase 2/3 单测红 | 改实装直到绿,不动现有 test |
| Phase 6 e2e 发现走的不是 havefun 网关 | 抓 trace + SIEM,核对 `register.ts` 注册到 pi 的 provider 名是否真的命中;必要时回 design.md §1.3 调整 provider 名 |
| 上线后 default 值触发 havefun 网关临时故障 | 业务方显式配 `LLM_PROVIDER`/`LLM_MODEL` 即可绕过,无需 hotfix |
