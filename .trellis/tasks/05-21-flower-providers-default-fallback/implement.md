# Implementation Plan · flower-providers env 缺省 fallback

> 三件套之 implement.md。基于 `prd.md` R1-R6 + `design.md` §1-§4。

## 总体顺序

```
Phase 1 · 实施前 spike:curl havefun 网关确认 havefun-openai-responses + gpt-5.5 可用   (~10 min)
Phase 2 · 加 3 常量 + 3 helper(env.ts) + 单测 8 case                                 (~30 min)
Phase 3 · 改 buildPiCliArgs + 改写 4 现有 case + 新增 5 case                          (~30 min)
Phase 4 · 整套质量门(typecheck + lint + 全单测)                                    (~10 min)
Phase 5 · README + spec 同步                                                         (~15 min)
Phase 6 · e2e:在 pineapple MR-2 跑一次"故意不配 env"的评审验证                     (~10 min)
Phase 7 · commit + archive                                                          (~10 min)
```

工作量预估:**≈ 1.75 小时**。

---

## Phase 1 · spike · 默认值可用性确认

**目的**:在改代码前用 curl 确认 havefun 网关确实开通了 openai-responses 协议 + `gpt-5.5` model id 可用。stress test pipeline 2127 已在 2026-05-21 用此组合跑通,这一步主要是"防止过去几天网关侧下线 / 变更"。

**Checklist**:
- [ ] 1.1 拿到 `LLM_BASE_URL` + `LLM_API_KEY`(从 pineapple Project Variables 借用,或问 ops)
- [ ] 1.2 `curl "$LLM_BASE_URL/v1/models" -H "Authorization: Bearer $LLM_API_KEY" | grep gpt-5.5` → 应返回 200 且含 gpt-5.5(注意网关 `/v1/models` 的 `supported_endpoint_types` 字段可能漏报 openai-response,需以人工知识为准)
- [ ] 1.3 真打一次 `POST $LLM_BASE_URL/v1/responses`(openai-responses 协议)发一句 "ping" → 200 + 正常 reply,响应里含 reasoning summary 字段
- [ ] 1.4 若 1.3 失败 → **回 PRD §3 R1 调整 DEFAULT_*** 值(候选:`havefun-anthropic + claude-sonnet-4-6 + high`,虽然与 stress 不一致但 anthropic 协议稳定)

**Review gate**:默认值在网关侧确认可用,再进 Phase 2。

---

## Phase 2 · env.ts 加常量 + helper + 单测

**目的**:落地 design.md §1.1-§1.2 的 3 常量 + 3 `OrDefault` 变体。

**Checklist**:
- [ ] 2.1 `packages/flower-providers/src/env.ts` 顶部(`ALLOWED_REASONING_EFFORTS` 附近)新增 3 个 export 常量:
  - `DEFAULT_LLM_PROVIDER: ProviderName = "havefun-openai-responses"`
  - `DEFAULT_LLM_MODEL = "gpt-5.5"`
  - `DEFAULT_LLM_REASONING_EFFORT: ModelThinkingLevel = "high"`
- [ ] 2.2 在 `getLLMProvider` 下方新增 `getLLMProviderOrDefault(): ProviderName`(实现见 design.md §1.2)
- [ ] 2.3 在 `getLLMModel` 下方新增 `getLLMModelOrDefault(): string`(同上)
- [ ] 2.4 在 `getLLMReasoningEffort` 下方新增 `getLLMReasoningEffortOrDefault(): ModelThinkingLevel`(同上)
- [ ] 2.5 `packages/flower-providers/src/__tests__/env.test.ts` 加 8 个 case(AC1.1-1.8):
  - 新增 `describe("getLLMProviderOrDefault")` 块:不配 → "havefun-openai-responses" / 合法 → 透传 / 非法 → throw
  - 新增 `describe("getLLMModelOrDefault")` 块:不配 → "gpt-5.5" / 任意非空 → 透传
  - 新增 `describe("getLLMReasoningEffortOrDefault")` 块:不配 → "high" / 合法 → 透传 / 非法 → throw
- [ ] 2.6 复用现有 `snapshotEnv` / `restoreEnv` / `clearEnv`(`ENV_KEYS` 已含所有 6 个 key,不需要扩)

**验证**:
```bash
cd packages/flower-providers && pnpm vitest run env.test
```

**Review gate**:helper 不破坏现有 `getLLMProvider` / `getLLMModel` / `getLLMReasoningEffort` 的契约;新 case 全绿;现有 case 不被改动。

---

## Phase 3 · runtime.ts 改 buildPiCliArgs + 改写现有 case + 新增

**目的**:落地 design.md §1.3 修改;同步更新现有 buildPiCliArgs 测试期望值。

**Checklist**:
- [ ] 3.1 `packages/flower-providers/src/runtime.ts` 顶部 import 调整:
  - 移除原 `getLLMReasoningEffort`(改用 OrDefault 变体)
  - 新增 `getLLMProviderOrDefault, getLLMModelOrDefault, getLLMReasoningEffortOrDefault`(从 env.ts)
- [ ] 3.2 重写 `buildPiCliArgs` 内的 provider/model/effort 处理:
  - 3 段调用 OrDefault helper 拿值
  - **缺 env 时**额外 `console.log("[flower-providers] LLM_X 未配置,fallback 到 \"<value>\"")`
  - 永远 push `["--provider", X, "--model", Y, "--thinking", Z]`(不再有"argv 不附加 --thinking" 这条路径)
- [ ] 3.3 改写 `__tests__/runtime.test.ts` 中现有 4 个 buildPiCliArgs case 的期望值:
  - L293 "env 全空" → argv 含 default provider + model + effort + 3 行 log
  - L298 "仅配 LLM_MODEL" → argv 含 default provider + 用户 model + default effort
  - L334 "LLM_PROVIDER 非法值 + LLM_MODEL 合法 → 降级" → 改为 `expect(() => buildPiCliArgs(...)).toThrow(/LLM_PROVIDER 非法值/)`
  - L341 "LLM_MODEL 空字符串 → 不附加 --model" → 改为 argv 含 default model
  - L293/L298/L311/L317/L341 凡是断言"不含某 flag"的 case,统一调整为"含 default 值的对应 flag"
  - L347 "LLM_REASONING_EFFORT 非法值 throw" 保留(`getLLMReasoningEffortOrDefault` 同样会抛)
  - L352 "EFFORT='off' 透传 --thinking off" 保留(用户值优先)
- [ ] 3.4 新增 5 个 case(AC1.9-1.13):
  - "env 全空 → argv 完整含 3 个 default"(独立 case 而非依赖现有改写)
  - "仅配 LLM_MODEL=claude-opus-4-7 → argv 含 default provider + 用户 model + default effort"
  - "三个 env 全配 → argv = 用户值,不被覆盖"
  - "LLM_PROVIDER=invalid → throw"(覆盖 fail-fast)
  - "缺省时 console.log spy 验证 3 行日志格式"(用 `vi.spyOn(console, "log")`)

**验证**:
```bash
cd packages/flower-providers && pnpm vitest run runtime.test
```

**Review gate**:`console.log` mock 检查到合理日志;改写后所有 buildPiCliArgs 现有 case + 新增 case 全绿;argv 顺序保持 `["-p", PROMPT, "--provider", X, "--model", Y, "--thinking", Z]`。

---

## Phase 4 · 整套质量门

**目的**:确保改动不破坏全局。

**Checklist**:
- [ ] 4.1 `pnpm -r typecheck`
- [ ] 4.2 `pnpm -r lint`
- [ ] 4.3 `pnpm -r test`(预计 149 → ~162:env.test +8、runtime.test 净新增 ~5,改写 ~4 个不变总数)
- [ ] 4.4 `git diff --stat` 确认只动 4 文件:env.ts、runtime.ts、env.test.ts、runtime.test.ts
- [ ] 4.5 grep 防回归:`buildPiCliArgs` 函数体内**不应**再出现 `getLLMReasoningEffort\b`(应改用 `getLLMReasoningEffortOrDefault`)— 注意 `getDefaultReasoningEffort` 仍合法调用 `getLLMReasoningEffort`,不要误删

---

## Phase 5 · README + spec 同步(含 3 处 spec drift 修正)

**目的**:文档与代码同步;**同时**修正本任务引入的 spec drift(发现于 trellis-before-dev 阶段)。

**Checklist**:
- [ ] 5.1 `packages/flower-providers/README.md` env 表 / 关键设计点:把 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT` 三行的"必填"列改为"✓ (SDK 路径)",在"含义"列追加"CLI 路径缺省 fallback 到 havefun-openai-responses / gpt-5.5 / high"
- [ ] 5.2 `.trellis/spec/flower-providers/backend/index.md` 在第 7 点"两个消费者的对称接口"表下方新增一段"CLI 路径 vs SDK 路径的缺省语义":
  - **CLI**(`buildPiCliArgs`):三个 env 缺省 → fallback 到 `havefun-openai-responses + gpt-5.5 + high`(2026-05-21 stress test 实测稳定组合)
  - **SDK**(`getDefaultModel` / `getDefaultReasoningEffort`):env 缺省 → throw / per-model 默认(显式配置,服务常驻)
  - 设计取向:CI 工具开放(降低业务方接入门槛),服务严格(部署运维必须显式配齐 env)
- [ ] 5.3 **spec drift 修正 1** · `backend/index.md` §6 关键设计点:删除 / 改写"code-reviewer 由 pi CLI 自己管 thinking level(`/thinking` 命令)"这句过时描述,改为"code-reviewer CLI 路径由 `buildPiCliArgs` 显式传 `--thinking <effort>`(env 缺省时 fallback 到 high);ops-bot SDK 路径由 `getDefaultReasoningEffort` 决定"
- [ ] 5.4 **spec drift 修正 2** · `backend/logging-guidelines.md`:在"Log Levels"表下方新增一节"例外:CLI 路径 fallback 提示",说明 `buildPiCliArgs` 在 env 缺省时**允许** `console.log("[flower-providers] LLM_X 未配置,fallback 到 \"<value>\"")`,理由:opt-in CI 工具需要让接入方明确感知"我在用默认值,改 env 可覆盖",info 级不会被 SIEM 误报。**仍禁止**输出 apiKey / baseUrl(本任务的 fallback 日志只含 provider name / model id / effort 字符串,均非敏感)
- [ ] 5.5 **spec drift 修正 3** · `backend/error-handling.md`:在 Common Mistakes "不要在 getDefaultModel 内退化"那条下方新增澄清:`buildPiCliArgs` 用 OrDefault helper 兜底**不是** "退化默认"的反模式,因为 (a) 仅 CLI 路径(opt-in),不是 SDK 路径(服务常驻必须 fail-fast)(b) 默认值是 stress 实测稳定组合而非"任意 anthropic + opus"(c) 缺省 fallback 但非法值仍 fail-fast,与 Common Mistakes 描述的"完全退化"语义不同

**Review gate**:spec 措辞清晰,不破坏现有目录结构;3 处 drift 修正确保未来读 spec 的人不会被旧描述误导。

---

## Phase 6 · e2e:pineapple MR-2 验证

**目的**:落地 AC2,在真实业务方仓里验证 fallback 生效 + 走 havefun 网关。

**Checklist**:
- [ ] 6.1 flower 本仓 commit + push,触发镜像 build pipeline,等新 image tag
- [ ] 6.2 在 pineapple `.gitlab-ci.yml` 锁 `FLOWER_IMAGE_TAG: <new-sha>`(或滚到 latest)
- [ ] 6.3 **删除**当前 .gitlab-ci.yml 中的 `LLM_PROVIDER` / `LLM_MODEL` / `LLM_REASONING_EFFORT` variables(显式测试缺省路径)
- [ ] 6.4 push 空 commit / retry pipeline
- [ ] 6.5 job trace 应当:
  - 看到 3 行 fallback 日志:
    - `[flower-providers] LLM_PROVIDER 未配置,fallback 到 "havefun-openai-responses"`
    - `[flower-providers] LLM_MODEL 未配置,fallback 到 "gpt-5.5"`
    - `[flower-providers] LLM_REASONING_EFFORT 未配置,fallback 到 "high"`
  - LLM 调用走 havefun 网关(SIEM / 网络日志侧确认 endpoint host)
  - 评审输出与 stress test pipeline 2127 / job 7552 等价(model=gpt-5.5,effort=high)

**Review gate**:3 行 fallback 日志真实出现 + LLM 真在网关 baseUrl 上有调用记录。

---

## Phase 7 · commit + archive

**Checklist**:
- [ ] 7.1 commit:
  ```
  [FEAT] flower-providers · CLI 路径 env 缺省 fallback 到 stress 实测组合(havefun-openai-responses + gpt-5.5 + high)

  BREAKING-NOTE: buildPiCliArgs 在 LLM_PROVIDER 配成非法值时,
  从原"吃错降级到只传 model"改为显式 throw `LLM_PROVIDER 非法值`。
  接入方若依赖此降级路径,需显式配齐合法值或移除非法配置。

  ops-bot 路径(getDefaultModel / getDefaultReasoningEffort)行为完全不变。
  ```
- [ ] 7.2 `task.py archive`
- [ ] 7.3 (可选)在 journal 写 1 行小结

---

## Rollback 点

| 阶段 | 失败如何回滚 |
|---|---|
| Phase 1 spike 失败 | 改 PRD §3 R1 默认值(fallback 候选:havefun-anthropic + claude-sonnet-4-6 + high),不进 Phase 2 |
| Phase 2/3 单测红 | 改实装直到绿,不动现有 test |
| Phase 6 e2e 发现走的不是 havefun 网关 | 抓 trace + SIEM,核对 `register.ts` 注册到 pi 的 provider 名是否真的命中;必要时回 design.md §1.3 调整 provider 名 |
| 上线后 default 值触发 havefun 网关临时故障 | 业务方显式配 `LLM_PROVIDER`/`LLM_MODEL` 即可绕过,无需 hotfix |
