# design.md — flower-code-reviewer:端到端跑通真实 MR 评审链路

> 本设计基于 prd.md(D1-D7 决策)。所有具体决策、AC、Out-of-Scope 见 prd.md,本文只描述「技术上怎么做、契约长什么样、坑在哪」。

---

## 1. 架构总览(Sequence)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ GitLab Pipeline (MR event)                                               │
│   $CI_PIPELINE_SOURCE == "merge_request_event"                           │
│   注入 env: CI_PROJECT_ID / CI_MERGE_REQUEST_IID / GITLAB_TOKEN /        │
│             LLM_BASE_URL / LLM_API_KEY / LLM_PROVIDER / LLM_MODEL /      │
│             LLM_REASONING_EFFORT / GITLAB_HOST / DEBUG_AUDIT             │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ flower-review CLI (cli.ts → run.ts)                                      │
│   1. parseArgs --mr-iid                                                  │
│   2. pickSkill()  ← gitlabClient().getMrFiles()                         │ ★
│   3. buildPrompt(skillFile)                                              │
│   4. buildPiArgv(prompt, env)   ← R4 新增                                │ ★
│   5. piMain(argv, { extensionFactories: [extensionFactory] })            │
│   6. blockerScan()  ← R2 新增                                            │ ★
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ pi-coding-agent print mode                                               │
│   注册顺序(extension.ts):                                              │
│     registerHavefunProviders → registerCompliance(ci-readonly)            │
│     → registerCommonTools → registerGitlabTools                          │
│                                                                          │
│   LLM 工具循环:                                                         │
│     gitlab_get_previous_review (避免重复)                                │
│     → gitlab_get_mr_files / gitlab_get_mr_diff                          │
│     → (read/grep 上下文,被 compliance 放行)                            │
│     → gitlab_post_line_comment / gitlab_post_comment                    │
│     → 若调 write/edit/curl 等被 compliance block,reason 上 stdout       │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼  HTTP REST
┌──────────────────────────────────────────────────────────────────────────┐
│ GitLab API @ http://gitlab.xhgjdev.com                                   │
│   /api/v4/projects/:id/merge_requests/:iid/changes                       │
│   /api/v4/projects/:id/merge_requests/:iid/notes                         │
│   /api/v4/projects/:id/merge_requests/:iid/discussions                   │
│   /api/v4/user (bot username 自查)                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

★ 标记的是本任务新增/实装的部分,共 3 个改动点 + 5 个 stub→真接口替换。

---

## 2. flower-tools-gitlab REST 客户端契约(R1)

### 2.1 类型层(保持不变,仅 stub → real)

`packages/flower-tools-gitlab/src/client.ts` 的 `GitlabClient` interface 已经定义(L31-37),**不改 interface**,只把 `createStubClient` 换成 `createRealClient`,并新增一个工厂函数 `getBotUsername()` 用于 `getBotComments`。

```ts
// 新增 (内部使用)
export async function fetchBotUsername(host: string, token: string): Promise<string>;
// → GET /api/v4/user, return body.username
// → 缓存到 module-level Map 避免每次跑都拉

// 新增 (公开,供单测注入)
export function createRealClient(host: string, token: string): GitlabClient;
```

### 2.2 endpoint 映射

| Interface 方法 | GitLab REST | 关键字段 |
|--|--|--|
| `getMrDiff(projectId, mrIid)` | `GET /api/v4/projects/:projectId/merge_requests/:mrIid/changes` | 返回 body 中的 `changes[*].diff` 字段拼接(每个 file 的 diff 用分隔线连)|
| `getMrFiles(projectId, mrIid)` | 同上 changes | 取 `changes[*].new_path`(`new_file=false && deleted_file=true` 时取 `old_path`)|
| `postMrComment(projectId, mrIid, body, severity)` | `POST /api/v4/projects/:projectId/merge_requests/:mrIid/notes` | body 前缀 `[severity:blocker]` 等便于过滤;请求体 `{ body: "..." }` |
| `postMrLineComment(projectId, mrIid, input)` | `POST /api/v4/projects/:projectId/merge_requests/:mrIid/discussions` | 需要 `position` 对象,见 2.3 |
| `getBotComments(projectId, mrIid)` | `GET /api/v4/projects/:projectId/merge_requests/:mrIid/notes?per_page=100` | 过滤 `n.author.username === botUsername`(`botUsername` 由 `fetchBotUsername` 拿) |

### 2.3 ⚠️ `discussions` 的 `position` 字段(已知坑点)

GitLab API 创建行内 discussion 需要传 `position` 对象,字段:

```ts
{
  position_type: "text",
  base_sha:  <MR base commit sha>,
  start_sha: <MR base commit sha>,  // 通常 = base_sha
  head_sha:  <MR head commit sha>,
  new_path:  <file path>,
  new_line:  <new line number>,
  // 如果是 deleted 行,改用 old_path / old_line
}
```

三个 sha 从 `getMrDiff` 同一接口返回的 `diff_refs` 对象拿(`{ base_sha, start_sha, head_sha }`),需要**在 client 内部缓存 per-MR**,避免每次发评论都拉一遍 changes。

实装策略:
- 在 `createRealClient` 内维护 `Map<string, DiffRefs>`,key = `${projectId}:${mrIid}`
- 第一次调 `getMrDiff` 或 `postMrLineComment` 时填充
- `postMrLineComment` 时如缓存缺,先内部 `GET changes` 拿 refs(不返回 diff,只拿 refs,避免重复带宽)

### 2.4 错误处理

| HTTP | 行为 |
|--|--|
| 200 / 201 | OK |
| 4xx(401/403/404/429)| 不重试,直接抛(429 也不重试,限流意味配额耗尽继续重试火上浇油)|
| 5xx | 重试 1 次(sleep 2s),仍失败则抛 |
| 网络错误 | 重试 1 次,仍失败则抛 |

**错误信息格式(统一)**:`GitLab <METHOD> <PATH> 失败:HTTP <STATUS> <BODY 前 200 字符>`

- 实例:`GitLab GET /api/v4/projects/g%2Fr/merge_requests/1/changes 失败:HTTP 401 {"message":"401 Unauthorized"}`
- 必含字段:HTTP 状态码、endpoint 路径(已 encode 的 projectId 与 mrIid 在 path 里)、响应体前 200 字符
- **不**按 401/403/404 分别格式化—— 统一格式更易维护;具体语义由 status code 表达
- **截 200 字符**:防 token / 内部信息全量泄漏到日志
- exitCode 不在客户端决定;由上层 `runReview`(成功跑完则 0/1)或 `cli.ts`(异常 catch 则 2)决定

### 2.5 baseUrl 拼接

`GITLAB_HOST` env 默认值 `https://gitlab.com`,实际值由用户提供(`http://gitlab.xhgjdev.com`),客户端**不应**强制 HTTPS,使用 URL 原样 + `/api/v4/...` 拼接。

---

## 3. `run.ts` 改造(R2 + R4)

### 3.1 当前 run.ts 流程(简化)

```ts
const skill = args.skill ?? await pickSkill();
const prompt = buildPrompt({ skillFilePath, dryRun });
await piMain(["-p", prompt], { extensionFactories: [extensionFactory] });
return { exitCode: 0, skillUsed: skill };  // ← 总是 0,blocker 扫描 TODO
```

### 3.2 改造后流程

```ts
const skill = args.skill ?? await pickSkill();
const prompt = buildPrompt({ skillFilePath, dryRun });

// R4: env → pi CLI argv
const piArgv = buildPiArgv({ prompt, dryRun });

// 跑前 snapshot: 现在 bot 已发的评论 list
const beforeIds = new Set(
  (await gitlabClient().getBotComments(projectId, mrIid)).map(c => c.id)
);

await piMain(piArgv, { extensionFactories: [extensionFactory] });

// R2: blocker 扫描
const after = await gitlabClient().getBotComments(projectId, mrIid);
const newComments = after.filter(c => !beforeIds.has(c.id));
const hasBlocker = newComments.some(c => /^\[severity:blocker\]/.test(c.body));
return { exitCode: hasBlocker ? 1 : 0, skillUsed: skill };
```

### 3.3 `buildPiCliArgs` 设计(R4 核心 · 落在 flower-providers)

**新增位置**:`packages/flower-providers/src/runtime.ts`(与 `buildHavefunModel` / `getDefaultReasoningEffort` 同文件),并在 `index.ts` re-export 公开。

```ts
import { getLLMModel, getLLMReasoningEffort } from "./env.js";

export interface BuildPiCliArgsInput {
  /** 已构造好的 prompt 字符串 */
  prompt: string;
}

/**
 * 把 LLM_MODEL / LLM_REASONING_EFFORT env 翻译到 pi-coding-agent CLI argv
 *
 * @remarks
 * 与 ops-bot 形态 `buildHavefunModel` + `getDefaultReasoningEffort` 对称——后者把
 * env 翻译成 SDK 入参(`Model<Api>` + `ModelThinkingLevel`),本函数把 env 翻译成
 * print 模式 argv(`string[]`)。两者输入相同(env),输出形态因消费者而异。
 *
 * 设计原则:
 * - env 缺省 → 不传对应 argv,让 pi CLI 走它自己的默认(prompt-only)
 * - LLM_MODEL 通过 `getLLMModel()` 校验(确保在合并模型清单内)
 * - LLM_REASONING_EFFORT 通过 `getLLMReasoningEffort()` 校验(6 级合法值,非法 fail-fast)
 * - **不**复用 `getDefaultReasoningEffort`:那是给 SDK 路径填默认用的(env > per-model > fallback);
 *   CLI 路径若 env 不配,应**透传给 pi CLI**(由 pi CLI 决定默认),不在本层填默认
 */
export function buildPiCliArgs(input: BuildPiCliArgsInput): string[] {
  const argv: string[] = ["-p", input.prompt];

  // LLM_PROVIDER + LLM_MODEL 各自显式传 --provider X --model Y。
  // 关键:仅传 --model 不行 —— pi 内置 modelRegistry 可能有同名 model id(如 `gpt-5.5` 在 azure-openai-responses
  // provider 下),且 ~/.pi/agent/settings.json 的 defaultProvider 会抢占,导致 pi 找不到我们的 havefun-* provider。
  // (此发现见 guides/debugging-llm-integration.md「pi CLI print 模式被默认 provider 抢占」决策树案例)
  let provider: string | undefined;
  try {
    provider = getLLMProvider();
  } catch {
    provider = undefined; // LLM_PROVIDER 缺省 / 非法时降级到只传 --model
  }
  if (provider !== undefined) {
    argv.push("--provider", provider);
  }
  try {
    const modelId = getLLMModel();
    argv.push("--model", modelId);
  } catch {
    // LLM_MODEL 未配置时 pi CLI 走默认 model,不传
  }

  const effort = getLLMReasoningEffort();
  if (effort !== undefined) argv.push("--thinking", effort);

  return argv;
}
```

**code-reviewer/run.ts 的消费**:

```ts
import { buildPiCliArgs } from "@flower-ai/flower-providers";
// ...
const piArgv = buildPiCliArgs({ prompt });
await piMain(piArgv, { extensionFactories: [extensionFactory] });
```

**接口对称表**:

| 消费者 | 入口 | flower-providers 提供 | 输出形态 |
|--|--|--|--|
| ops-bot | `new Agent({ streamFn })` | `buildHavefunModel` + `getDefaultReasoningEffort` | `Model<Api>` + `ModelThinkingLevel` |
| code-reviewer | `piMain(argv, ...)` | `buildPiCliArgs` | `string[]` |

**dryRun** 通过 prompt 文案处理(prompts.ts L29-31 已实装),与 argv 无关。

### 3.4 blocker 扫描的 severity 约定

LLM 通过 `gitlab_post_comment` / `gitlab_post_line_comment` 工具发评论时,severity 是参数,但**发到 GitLab 后只是评论 body**——没有原生 severity 字段。

策略:client.ts 在 `postMrComment` / `postMrLineComment` 把 body **前缀** `[severity:<level>] ` 写进真实评论,这样:
- GitLab UI 上用户能看到严重程度
- blocker 扫描 regex `^\[severity:blocker\]` 简单可靠
- 改前缀格式只需要改一处

这是 R2 与 R1 的一个耦合点,需要在 design 阶段明确(否则实装时两边各做一半会断链)。

---

## 4. flower-compliance 单测(R5 / CP3)

### 4.1 目录结构

```
packages/flower-compliance/src/
├── index.ts
├── audit.ts
└── __tests__/        ← 新增
    ├── index.test.ts
    └── audit.test.ts
```

### 4.2 测试策略 — mock pi.on

```ts
import { describe, it, expect, vi } from "vitest";
import { registerCompliance } from "../index.js";

type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }) =>
  Promise<{ block: boolean; reason: string } | undefined>;

function mockPi() {
  const handlers: Record<string, Function[]> = {};
  return {
    pi: {
      on(name: string, fn: Function) { (handlers[name] ??= []).push(fn); },
    },
    trigger: (event: string, payload: any) => Promise.all((handlers[event] ?? []).map(h => h(payload))),
  };
}

it("ci-readonly:write 工具被拦", async () => {
  const { pi, trigger } = mockPi();
  registerCompliance(pi as any, { mode: "ci-readonly", product: "test" });
  const [res] = await trigger("tool_call", { toolName: "write", input: {} });
  expect(res).toEqual({ block: true, reason: expect.stringContaining("禁止使用 write") });
});
```

类似的 case 见 PRD AC13 列表。

### 4.3 audit.test.ts 关键

需要 mock `globalThis.fetch`(vitest 默认提供),mock `process.env` 用 `vi.stubEnv`:

```ts
vi.stubEnv("SIEM_INGEST_URL", "");
// expect fetch not called
vi.stubEnv("SIEM_INGEST_URL", "http://siem.example/ingest");
vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
// expect fetch called with right URL + body
```

---

## 5. e2e 测试数据策略(R3.a / R3.b)

### 5.1 fork sandbox 准备(任务执行前 · 用户操作)

1. 在 `http://gitlab.xhgjdev.com/digital-independent-projects/srm-esign` 上点 Fork → 落到 `<FORK_NAMESPACE>/srm-esign`
2. 在 fork 仓库 Settings → Access Tokens 或 Personal Access Token,创建一个有 `api` scope 的 token,记录 token 字符串 + 对应的 bot username
3. 把 token 写进 GitLab CI/CD masked variable `REVIEWER_BOT_TOKEN`(项目 CI/CD 设置里)

### 5.2 MR-general 构造

在 fork 默认分支(`main` 或 `master`)拉一个新分支 `e2e/test-general`,只改动:
- `README.md` 加 2-3 行说明
- 或新增 `docs/code-review-test.md`

提 MR 时 selector 看不到任何 `auth/login/...` 关键词,也无后端/前端典型后缀 → 落到 `general`。

### 5.3 MR-security 构造

新分支 `e2e/test-security`,**新增**一个文件(允许新增,因 srm-esign 可能没有现成 auth 路径):

```
src/auth/login-helper.ts   或   src/main/java/com/.../auth/SignVerify.java
```

文件内**故意埋一两个**:

```ts
// 种子问题 #1: SQL 拼接
function getUser(name: string) {
  return db.query(`SELECT * FROM users WHERE name = '${name}'`);
}

// 种子问题 #2: 硬编码 secret(只作为种子,不是真 token)
const SIGN_SECRET = "abc123-please-replace-me";
```

selector L30 命中 `auth` → 落到 `security`。

### 5.4 GitLab CI job

在 fork 仓库的 `.gitlab-ci.yml` 加 review job(模板见 `.gitlab-ci.example.yml`),设 `image: <内部 registry>/flower-code-reviewer:0.1.0`(本任务期间可以先用 `tsx src/cli.ts` 在 runner 直跑,跳过镜像打包步骤,本任务不验镜像)。

---

## 6. 兼容性与回滚

### 6.1 改动范围

| 文件 | 改动类型 |
|--|--|
| `packages/flower-tools-gitlab/src/client.ts` | stub → real,interface 不变;新增内部 `gitlabFetch` / `createRealClient` / `_resetClientForTests`(供单测重置模块级缓存) |
| `packages/flower-tools-gitlab/src/index.ts` | 新增 `export type { BotComment, GitlabClient, LineCommentInput }`(run.ts 与单测需要类型) |
| `packages/flower-tools-gitlab/src/__tests__/client.test.ts` | 新增 |
| `packages/flower-tools-gitlab/package.json` | 加 `"test": "vitest run"` script + vitest devDep |
| `packages/flower-providers/src/runtime.ts` | 新增 `buildPiCliArgs` 公开函数 + `BuildPiCliArgsInput` 接口 |
| `packages/flower-providers/src/index.ts` | re-export `buildPiCliArgs` + `BuildPiCliArgsInput` |
| `packages/flower-providers/src/__tests__/runtime.test.ts` | 扩展,新增 9 个 buildPiCliArgs case |
| `packages/flower-code-reviewer/src/run.ts` | 加 blocker 扫描 + 调 buildPiCliArgs;新增 `scanForBlockers` export(供单测) |
| `packages/flower-code-reviewer/src/__tests__/run.test.ts` | 新增 |
| `packages/flower-code-reviewer/package.json` | 加 `"test": "vitest run"` script + vitest devDep |
| `packages/flower-compliance/src/__tests__/{index,audit}.test.ts` | 新增 |
| `packages/flower-compliance/package.json` | 加 `"test": "vitest run"` script + vitest devDep |
| `packages/flower-code-reviewer/.gitlab-ci.example.yml` | 本期未改(模板已够用)|

**接口契约层零破坏**(GitlabClient interface / extension.ts 不变),ops-bot 不受影响;新增的 `buildPiCliArgs` 是纯增量公开 API,不影响现有 ops-bot 路径;`flower-tools-gitlab/index.ts` 新增的 type re-export 也是纯增量。

### 6.2 回滚

git revert HEAD,无 DB / 无外部 state / 无不可逆操作。

### 6.3 兼容性

- pi-coding-agent 0.75.x:已确认支持 `--thinking <level>` / `--model <id>`,无需升级
- flower-providers:gpt-5.5 已注册,thinkingLevelMap 走默认,无需变更

---

## 7. Tradeoffs(记录,便于将来回顾)

| 决策 | 备选 | 选择理由 |
|--|--|--|
| 自包 fetch 写 REST 客户端 | 引入 `@gitbeaker/rest` SDK | 5-6 个 endpoint 不值得引一个百 KB 的 SDK;错误信息可控 |
| severity 前缀写进评论 body | 用 GitLab labels / discussion resolved 字段 | labels 是 MR 级别不是 note 级;resolved 语义不一致;前缀 + regex 最简 |
| blocker 扫描走 getBotComments | 让 LLM 通过工具上报 blocker | LLM 不可信(可能漏报);拉评论 list 是 ground truth |
| buildPiCliArgs 公开在 flower-providers | code-reviewer 内联实现 | 用户选 B,与 flower-providers「env 解析集中」的设计哲学对齐;接口对称(SDK 路径有 buildHavefunModel,CLI 路径有 buildPiCliArgs)|
| 不主动诱导 LLM 调危险工具 | 改 prompts.ts 加诱导段 | CP1+CP3 已经能验证拦截规则,不污染主 prompt |

---

## 8. Rollout / Rollback shape

- **Rollout**:本任务最后一步是「在 fork 仓库上跑两个 MR 各两次,核验 AC5-AC14」;跑完即视为交付
- **Rollback**:若 e2e 阶段发现 GitLab API 与文档不符(尤其是 discussions position 字段),先在 design.md 加注,再迭代 client.ts;若整个方向死局(应当不会),git revert 整个分支
- **生产部署**:本任务**不**触发任何生产部署;`.gitlab-ci.example.yml` 给业务侧参考,实际接入由业务团队执行
