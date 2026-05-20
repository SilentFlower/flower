/**
 * 评审 prompt 构造
 *
 * 关键约束(必须写进 prompt 里,LLM 才会照做):
 * 1. 所有评审意见必须通过 gitlab_post_comment / gitlab_post_line_comment 发表
 * 2. 不要在 stdout 输出"评审报告"
 * 3. 优先用 gitlab_get_previous_review 看历史,避免重复评论
 * 4. severity 三档:`blocker | major | minor`(只对真问题打 blocker;对齐 render / tool schema 词表)
 * 5. 评论 markdown 样式遵循 §「评论 markdown 样式(强制)」段,完整 CodeRabbit-like 4 段式 + walkthrough 折叠
 *    (Phase 1 N2 评论质量优化产物;依据 research/comment-style.md §5/§6 verbatim 复制)
 * 6. **每变更文件必读**:对每个 MR 变更文件必须先调用 `gitlab_get_file_content` 拉完整内容
 *    再评论;否则会被 `scanForBlockers` 拦截为「无依据评论」blocker(Phase 2 N1 落地)
 *
 * GitLab alert 块兼容:`> [!caution]` 仅 GitLab 17.10+ 支持;`buildPrompt` 根据 `gitlabVersion`
 * 入参动态切换 §6.6 模板的 alert 块格式,LLM 学到的 few-shot 就是"对应版本的正确写法"。
 */

import { readFileSync } from "node:fs";
import { supportsAlertBlock } from "./comments/index.js";

/**
 * 构造 prompt 的输入
 */
export interface BuildPromptInput {
	/** skill 文件的绝对路径 */
	skillFilePath: string;
	/** 试跑模式 */
	dryRun: boolean;
	/**
	 * GitLab 服务端版本(用于 alert 块降级)
	 *
	 * - `{ major: 17, minor: 10 }+` → §6.6 模板用 `> [!caution]`
	 * - 其他 / null → §6.6 模板降级到 `> ⚠️ **Caution**` blockquote
	 */
	gitlabVersion?: { major: number; minor: number } | null;
	/**
	 * E2 · diff 截断元数据(可选)
	 *
	 * 当 MR 文件数超过 `FLOWER_MAX_FILES` 时,run.ts 按 churn 降序取 top N,
	 * 把 `{shown, total, files}` 传到这里 → prompt 提示 LLM「本次只看到部分文件,
	 * walkthrough 必须写截断说明」。
	 *
	 * - `shown`:实际能看的文件数
	 * - `total`:MR 真实文件总数
	 * - `files`:已截断后保留的文件路径列表(按 churn 降序)
	 *
	 * 不传 / undefined → 不触发截断,prompt 无相关段。
	 */
	truncation?: {
		shown: number;
		total: number;
		files: string[];
	};
}

/**
 * 构造完整的评审 prompt
 */
export function buildPrompt(input: BuildPromptInput): string {
	const skillContent = readSkill(input.skillFilePath);
	const useAlertBlock = supportsAlertBlock(input.gitlabVersion ?? null);

	const dryRunHint = input.dryRun
		? "\n\n**注意:当前是 dry-run 模式,请仍然输出你打算发的评论(转 stdout),但不要调用 gitlab_post_* 工具。**"
		: "";

	const truncationHint = renderTruncationHint(input.truncation);

	return `你是资深代码评审 agent。请对当前 GitLab MR 做评审。

## 评审清单

${skillContent}

## 工作流程

1. 先调用 \`gitlab_get_previous_review\` 看自己之前在本 MR 发过哪些评论,**不要重复**。
2. 调用 \`gitlab_get_mr_files\` 看修改了哪些文件。
3. 调用 \`gitlab_get_mr_diff\` 看完整 diff。
4. **每个变更文件**:必须调用 \`gitlab_get_file_content\` 拉完整内容(ref 传 MR source branch HEAD;
   想看 target 版本或历史 commit 可传对应 ref)。
5. 必要时再调用 \`gitlab_get_file_content\` 拉**相关上下文**(被改函数实现 / 被改类定义 / 调用方)。
6. 对每个有问题的地方,调用 \`gitlab_post_line_comment\` 发行内评论。
7. 全部评审完后,如有总结性意见,调用 \`gitlab_post_comment\` 发整体评论。

## 严格要求

- **所有意见必须通过工具发表,不要在文本输出里给意见**。CI 日志没人看。
- severity 仅在以下情况打 \`blocker\`:
  - 安全漏洞(SQL 注入、XSS、敏感信息泄漏等)
  - 明显的逻辑错误会导致生产事故
  - 不符合团队/项目的硬性合规要求
- 风格 / 命名 / 建议性问题打 \`major\` 或 \`minor\`。
- 评论要给出**具体修改建议**,不要只说"这里不好"。
- 不确定的地方,宁可不发,不要发错的。${dryRunHint}

## 评论 markdown 样式(强制)

1. **行内评论(gitlab_post_line_comment)**必须按 4 段式:
   - 第 1 行:\`<emoji> **<等级 中文>** <一句话问题标题>\`(纯 emoji + 加粗等级即可,**不要**写 \`[severity:*]\` 字面 marker)
     - level ∈ {blocker, major, minor},分别对应 emoji + 中文等级:🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**
     - 例:\`🔴 **阻塞** 硬编码 secret 泄漏风险\`
   - 第 2-4 行:解释段落,1-3 句,讲 why(diff 已经在 GitLab UI 显示了 what)
   - 折叠区 1(可选):\`<details><summary>修复建议</summary>\` 包 \` \`\`\`suggestion \` 块
   - 折叠区 2(可选):\`<details><summary>推理过程</summary>\` 包 reasoning,默认折叠避免刷屏

2. **整体评论(gitlab_post_comment)**用 walkthrough 结构,**整个 body 包在 \`<details>\` 里默认折叠**:
   - \`## 概要\`(2-3 句变更总览)
   - \`## 文件变更\`(表格:文件路径 | 一句话总结 | 关注等级)
   - \`## 行动建议\`(任务列表,如有 blocker)
   - 不要生成 emoji 诗

3. **「无问题」轻量评论**:只发一条整体评论,正文 ≤ 3 行,不折叠:
   \`\`\`
   :white_check_mark: 已审,未发现需要修改的问题。
   <一句话补充,如关注的点或值得肯定的实现>
   \`\`\`

4. **GitLab quick action 禁令**:绝对不要生成以 \`/\` 开头的整行(如 \`/approve\` \`/close\` \`/assign\`),
   GitLab 会把它当 quick action 真的执行。如果评论中需要展示路径,用反引号包(\`\` \`/path/to/file\` \`\`)。

5. **emoji 用 GLFM 兼容的 shortcode**(\`:warning:\` 而不是原生 ⚠️),便于 GitLab 自定义 emoji 渲染。
   例外:severity 行的 🔴/🟠/🔵 用 unicode 直接写(GitLab/GitHub 都直接渲染)。

6. **severity 等级表达**:行内评论第 1 行用 emoji + 加粗中文等级(🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**)表达,
   **不要**写 \`[severity:*]\` 字面 marker。blocker 评论的机器可读 marker 由 \`gitlab_post_line_comment\` /
   \`gitlab_post_comment\` 工具自动以 HTML 注释形式注入(用户看不到),不需要你在 body 里手写。
   只对真问题打 blocker(参考现有规则)。

7. **真实代码上下文约束**(Phase 2 N1):对 MR 改动的**每个变更文件**,必须先调用
   \`gitlab_get_file_content\`(ref 默认 MR source branch HEAD)拉完整内容再发出评论。
   鼓励主动拉**相关上下文**(被改函数实现 / 被改类定义 / 调用方),用 \`gitlab_get_file_content\`
   传任意 ref 和路径即可。
   **未拉文件直接发该文件的行内评论 → 视为「无依据评论」 → \`scanForBlockers\` 会拦截为 blocker
   (自我阻塞)**。
   你可以重复读同一文件(client 内部已防重复请求),但**不能跳过读取**。

8. **MR diff size cap**(Phase 3 E2,**仅在触发截断时生效**):
   如果下方出现「**MR 文件截断说明**」段,意味着本次 MR 文件数超过上限,你看到的
   \`gitlab_get_mr_files\` 输出只包含按 churn(增量 + 删除行数)排序的 top N 个文件,
   完整列表的其余文件**本次不评审**。此时:
   - 你的 walkthrough 整体评论的 \`## 文件变更\` 表格只列出本次评审的文件
   - **必须**在 walkthrough 内增加一行 \`⚠️ 本次仅评 <shown>/<total> 个最大变更文件(按 churn 排序),其余请手工 review\`
   - 不要对未列出的文件发行内评论(那些文件不在 \`gitlab_get_mr_files\` 返回中,且未通过 \`gitlab_get_file_content\` 读取)
${truncationHint}

## 模板示例(few-shot;落地时按场景照搬)

### 示例 1 · MR 整体评论模板

\`\`\`markdown
<details>
<summary>:robot: <b>代码评审报告</b> (flower-code-reviewer)</summary>

## 概要

本次 MR 在 \`internal/auth/\` 下新增了签名验证流程,涉及 1 个新文件与 2 个文件改动。整体实现思路合理,但发现 **1 个安全 blocker** 与 **2 个 minor 建议**,详见下方行内评论。

## 文件变更

| 文件 | 一句话总结 | 关注等级 |
|---|---|---|
| \`internal/auth/sign_verify.go\` | 新增签名验证主流程 | :red_circle: blocker |
| \`internal/auth/sign_verify_test.go\` | 单测覆盖 happy path | :large_blue_circle: minor |
| \`cmd/server/main.go\` | 注册 sign verify middleware | :large_blue_circle: minor |

## 行动建议

- [ ] 必须修复:\`sign_verify.go:42\` 硬编码 secret,改用环境变量
- [ ] 建议补充:\`sign_verify_test.go\` 缺 invalid signature 的负向 case
- [ ] 可选优化:\`main.go\` middleware 注册顺序建议提前到 auth 之后、业务 handler 之前

</details>
\`\`\`

### 示例 2 · 行内评论(severity:blocker · 带 suggestion 块)

\`\`\`markdown
🔴 **阻塞** · 硬编码 secret 存在凭据泄漏风险

\`hmacSecret\` 变量直接以字符串字面量出现在源码中。一旦本仓库被 fork 或者代码被 leak,凭据将立刻失效需要轮转,且 git 历史也会永久包含该值。

公司合规要求所有密钥必须来自环境变量或 secret manager。

<details>
<summary>修复建议(可点 Apply suggestion 直接落地)</summary>

\`\`\`suggestion
hmacSecret := os.Getenv("SIGN_VERIFY_HMAC_SECRET")
if hmacSecret == "" {
    return nil, fmt.Errorf("SIGN_VERIFY_HMAC_SECRET env var is required")
}
\`\`\`

</details>

<details>
<summary>:bulb: 为什么判定为 blocker</summary>

参照《应用安全编码规范 v3.2》§4.1:**任何长度 ≥ 16 字节的字符串字面量若被用于 hmac/aes/rsa key,必须 block**。本例 \`"sk_live_aB3xQ..."\` 命中此规则。

若此为测试 fixture,请加 \`// nolint:secrets // test fixture\` 显式豁免。

</details>
\`\`\`

### 示例 3 · 行内评论(severity:major · 无修复 suggestion)

\`\`\`markdown
🟠 **重要** · 签名校验失败时未记录审计日志

当 \`hmac.Equal\` 返回 false 时,函数直接返回 \`false, nil\`,没有任何日志输出。安全事件追溯将无法定位攻击源。

参考 \`internal/audit/logger.go\` 中已有的 \`AuditLog(ctx, "sign_verify_failed", ...)\` 模式补充审计日志即可。
\`\`\`

### 示例 4 · 行内评论(severity:minor · 带 reasoning 折叠)

\`\`\`markdown
🔵 **建议** · 常量 \`MaxSignatureAge\` 建议提到包级

当前 \`MaxSignatureAge = 5 * time.Minute\` 内联在函数体里,如果未来需要按环境调优(测试 vs 生产),改起来需要改函数签名。

<details>
<summary>:bulb: 推理过程</summary>

- 这是个边缘建议,不影响功能正确性
- 但参考本仓库 \`internal/config/\` 下其他时间常量(如 \`JwtExpiry\` \`RefreshTokenTtl\`)都已经包级公开 + 通过 \`viper.GetDuration\` 注入
- 保持一致性会降低后续维护心智负担

不强制改,留作 follow-up 即可。

</details>
\`\`\`

### 示例 5 · 「无问题」轻量评论

\`\`\`markdown
:white_check_mark: 已审 \`internal/auth/sign_verify.go\`,未发现需修复的问题。

签名校验流程清晰、负向 case 覆盖到位,可以合并。
\`\`\`

—— 仅 2 行 + 1 空行,GitLab UI 上不超过半屏,避免视觉噪声。

### 示例 6 · 全 blocker 拦截整体评论顶部 alert 块(可选,仅在有 ≥1 个 blocker 时插入)

${renderAlertBlockExample(useAlertBlock)}

现在开始评审。`;
}

/**
 * 渲染 E2 截断说明段(仅在触发截断时插入到 prompt)
 *
 * 拼接 LLM 可直接消费的"截断元数据":
 * - 本次实际能看到的文件数 / MR 总文件数
 * - 已保留(按 churn 排序)的文件路径清单
 *
 * 注:**不**写"忽略其余文件"之类话术 — LLM 用 \`gitlab_get_mr_files\` 拿到的本来就是
 * 截断后的列表,这里只是告知"全貌是 M 个、你看到 N 个"以便正确写 walkthrough 截断行。
 *
 * @param truncation E2 截断元数据(可选);不传 → 返回空字符串
 * @internal 仅 buildPrompt 调用
 */
function renderTruncationHint(truncation?: { shown: number; total: number; files: string[] }): string {
	if (truncation === undefined) return "";
	const fileList = truncation.files.map((p) => `   - \`${p}\``).join("\n");
	return [
		"",
		"### MR 文件截断说明(E2)",
		"",
		`> ⚠️ 本次 MR 实际有 **${truncation.total}** 个变更文件,超过 \`FLOWER_MAX_FILES\` 上限。`,
		`> 已按 churn(\`additions + deletions\`)降序取 top **${truncation.shown}**,其余文件本次**不评审**。`,
		">",
		"> 本次保留的文件清单:",
		fileList,
		"",
	].join("\n");
}

/**
 * 渲染 §6.6 alert 块示例(根据 GitLab 版本动态切换)
 *
 * 为什么动态:
 * - GitLab 17.10+ 支持 \`> [!caution]\` GitHub-style alert,渲染为红色警示卡片
 * - 旧版本会渲染成裸 \`[!caution]\` 字面文本,需降级到 \`> ⚠️ **Caution**\` 普通 blockquote
 * - LLM 学到的 few-shot **就是对应版本能正常渲染的语法**,避免上线后看到原始字面量
 *
 * @param useAlertBlock 是否使用 GitHub-style alert(17.10+ 为 true)
 * @internal
 */
function renderAlertBlockExample(useAlertBlock: boolean): string {
	const alertSyntax = useAlertBlock ? "> [!caution]\n> " : "> ⚠️ **Caution**\n> ";
	const noteFooter = useAlertBlock
		? "> 注:本 GitLab 服务端支持 `> [!caution]` GitHub-style alert,LLM 输出请直接用上面的语法。"
		: "> 注:本 GitLab 服务端版本 <17.10,不支持 `> [!caution]` alert 块。LLM 输出请用上面的 `> ⚠️ **Caution**` blockquote 降级语法。";

	return [
		"```markdown",
		`${alertSyntax}本次评审发现 **N 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。`,
		">",
		"> Blocker 列表:",
		"> - `internal/auth/sign_verify.go:42` — 硬编码 secret",
		"> - `internal/db/migrations/002.sql:7` — 缺索引导致全表扫描",
		"```",
		"",
		noteFooter,
	].join("\n");
}

/**
 * 读取 skill 文件内容
 */
function readSkill(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		console.warn(`[code-reviewer] 无法读取 skill: ${path}, 使用空清单`);
		return "(未提供专项清单,按通用编码规范评审)";
	}
}
