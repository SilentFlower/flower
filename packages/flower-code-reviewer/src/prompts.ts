/**
 * 评审 prompt 构造
 *
 * 关键约束(必须写进 prompt 里,LLM 才会照做):
 * 1. 所有评审意见必须通过 gitlab_post_comment / gitlab_post_line_comment 发表
 * 2. 不要在 stdout 输出"评审报告"
 * 3. 优先用 gitlab_get_previous_review 看历史,避免重复评论
 * 4. severity 三档:`blocker | major | minor`(只对真问题打 blocker;对齐 render / tool schema 词表)
 * 5. 评论 markdown 样式遵循 §「评论 markdown 样式(强制)」段,完整 CodeRabbit-like 4 段式 +
 *    walkthrough 折叠 + 面向测试的第二条整体评论默认折叠
 *    (Phase 1 N2 评论质量优化产物;依据 research/comment-style.md §5/§6 verbatim 复制)
 * 6. **评论前必读相关行窗**:对某文件发出行内评论前必须先调用 `gitlab_get_file_content`
 *    读取变更行附近上下文;否则会被 `scanForBlockers` 拦截为「无依据评论」blocker
 * 7. **harness 上下文注入 + 需求/依据三分语义**(2026-06-10 R1/R3):宿主启动期沿 namespace
 *    祖先链自动发现 harness 并经 `harnessContext` 注入;测试说明的`需求/依据`必须按
 *    ①引用 harness 文件 / ②已查询未找到(需有 prepare 记录)/ ③低风险未查询 三选一,
 *    旧句式"未找到权威需求依据"废弃,run 结束由 `scanHarnessEvidence` 机器校验
 *
 * GitLab alert 块兼容:`> [!caution]` 仅 GitLab 17.10+ 支持;`buildPrompt` 根据 `gitlabVersion`
 * 入参动态切换 §6.6 模板的 alert 块格式,LLM 学到的 few-shot 就是"对应版本的正确写法"。
 */

import { readFileSync } from "node:fs";
import type { HarnessDiscoveryResult } from "@flower-ai/flower-tools-gitlab";
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
	/**
	 * 当前 MR 的 source branch 名(`CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`)
	 *
	 * 工作流第 4 步要求 LLM **显式传** ref(= 本字段),避免触发工具兜底产生 warn 噪音;
	 * 不传 / 空 → prompt 提示 LLM 「ref 可省略,工具会兜底到 source branch」(降级路径)。
	 */
	sourceBranch?: string;
	/**
	 * 每轮最多读取多少个代码行窗
	 *
	 * 这是 prompt 约束,用于避免 LLM 一次性并发拉十几个大文件窗口。
	 * 不传时按 5 个窗口描述。
	 */
	contextReadBatchSize?: number;
	/** 未指定行号时工具默认返回多少行 */
	contextReadDefaultLines?: number;
	/** 工具单次最多返回多少行 */
	contextReadMaxLines?: number;
	/**
	 * 跨项目 harness 上下文(R1 · 宿主启动期沿 namespace 祖先链自动探测)
	 *
	 * 把"模型自己猜 harness 在哪"变成"宿主直接告诉它在哪":
	 * - `discovery.project` 非空 → 注入 harness 位置 + 分支清单,模型可直接 prepare
	 * - `discovery.project` 为 null → 注入"已沿 searchedGroups 探测、未发现"事实,
	 *   模型在`需求/依据`如实引用
	 * - `discovery` 为 null → 宿主探测降级(异常被吞),注入兜底提示让模型可自行发现
	 * - 整个字段不传 / undefined → 不渲染注入段(本地调试向后兼容)
	 */
	harnessContext?: {
		/** 当前 MR 项目路径,例如 `digital-biz-projects/srm/fronts/srm-admin-front` */
		projectPath: string;
		/** 当前项目 namespace,例如 `digital-biz-projects/srm/fronts` */
		namespace: string;
		/** 宿主探测结果;null = 探测过程降级失败 */
		discovery: HarnessDiscoveryResult | null;
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
	const harnessHint = renderHarnessContextHint(input.harnessContext, input.sourceBranch);
	const contextReadBatchSize = input.contextReadBatchSize ?? 5;
	const contextReadDefaultLines = input.contextReadDefaultLines ?? 500;
	const contextReadMaxLines = input.contextReadMaxLines ?? 1000;

	return `你是资深代码评审 agent。请对当前 GitLab MR 做评审。

## 评审清单

${skillContent}

## 工作流程

1. 先调用 \`gitlab_get_previous_review\` 看自己之前在本 MR 发过哪些评论,**不要重复**。
2. 调用 \`gitlab_get_mr_files\` 看修改了哪些文件。
3. 调用 \`gitlab_get_mr_diff\` 看完整 diff。diff hunk 内的 \`add\` / \`ctx\` 行会标注新文件行号,这些才是 \`gitlab_post_line_comment.line\` 的优先来源;\`del\` 行没有可用 new_line。
4. 基于 diff 初筛风险点,不要为了覆盖率把所有变更文件无脑读取一遍。
5. 准备对某文件发表行内评论、diff 不足以支撑判断、或需要确认被改函数 / 类型 / 调用方时,调用 \`gitlab_get_file_content\` 读取**相关行窗**。
   - **看 MR source 版本**(评审主路径):\`ref\` 参数**必须传** \`"${input.sourceBranch ?? "<MR source branch — env CI_MERGE_REQUEST_SOURCE_BRANCH_NAME>"}"\`(本 MR 当前 source branch),不要省略也不要传 \`"HEAD"\`
   - **看 target 版本 / 历史 commit**:显式传 branch 名 / commit sha
   - **优先传行号**:\`startLine\` / \`endLine\` 取变更行附近窗口(例如变更行前后 80-150 行),避免读取不相关代码
   - 未传行号时工具只返回文件开头默认 ${contextReadDefaultLines} 行;单次最多返回 ${contextReadMaxLines} 行
   - 没拿到想要的数据时,按工具返回的续读提示读取相邻下一段或上一段
   - 每一轮最多读取 **${contextReadBatchSize}** 个行窗,按 blocker 风险和评论必要性排序
   - 工具对 \`"HEAD"\` / 空字符串 / 缺省会兜底到 source branch 并 warn 教育,**主动正确传值**避免噪音
   - **注意**:\`gitlab_get_file_content\` 返回的是完整文件行窗,只用于理解上下文;发表行内评论时不要把行窗里的普通行号直接当作可评论位置。
6. 对每个有问题的地方,调用 \`gitlab_post_line_comment\` 发行内评论。
   - \`line\` 必须优先取自步骤 3 的 MR diff 标记行:只能选 \`add\` / \`ctx\` 对应的新文件行号,不要选 \`del\` 行。
   - 如果问题语义落在未改动函数或完整文件行号上,请选择同一 hunk 中最贴近问题的 \`add\` / \`ctx\` 标记行。
   - 只有当 diff 标记行不足以定位问题时,才允许依赖工具自动重定位或降级整体评论;不要主动传明显不在 diff hunk 中的行号。
7. **校对本轮 blocker 真值(强制)**:发完所有 line_comment 后,**必须**调用一次
   \`reviewer_list_my_blockers\`(无参),拿到本轮你刚发的 blocker 列表 \`{count, blockers:[{path,line,title}]}\`。
   这是写下一步 walkthrough alert 块的**唯一真值**,**严禁**靠对话历史记忆数。
8. 全部评审完后,**必须先**调用 \`gitlab_post_comment\` 发送第一条整体评论:代码评审 walkthrough。
   - 若步骤 7 拿到 \`count >= 1\`:walkthrough 顶部**必须**插入 \`> [!caution]\` alert 块(GitLab 17.10+)
     或降级 \`> ⚠️ **Caution**\` blockquote(< 17.10),其中:
     - **N 数字** = 步骤 7 的 \`count\`(不允许靠记忆数)
     - **Blocker 列表** = 步骤 7 的 \`blockers\` 数组,**逐条照抄**为 \`- \\\`<path>:<line>\\\` — <title>\`,
       **不允许**摘要 / 漏列 / 增列 / 改字面值 / 调整顺序
   - 若步骤 7 \`count === 0\`:**不要**插入 alert 块(沿用"无 blocker 不插 caution"约定)
   - 即使没有行内问题,也要给出本次 MR 的简洁代码评审 walkthrough;不要只用一条"已审无问题"结论结束评审。
9. **必须再**调用一次 \`gitlab_post_comment\`,发送第二条整体评论:\`面向测试的变更说明\`。
   - 这条评论只服务测试人员理解"这次 MR 做了什么、影响哪里、该怎么测",**不得**塞进代码评审 walkthrough。
   - 这条评论的整个 body 也**必须**包在 \`<details>\` 里默认折叠,不要加 \`open\` 属性;summary 固定使用 \`:test_tube: <b>面向测试的变更说明</b>\`。
   - 必须包含 \`变更摘要\` / \`影响范围\` / \`测试关注点\` / \`需求/依据\` 四项。
   - \`需求/依据\` **严格按实际行为三选一**(写法见「评论 markdown 样式」§3):①引用 harness 文件 + ref/commit;②已查询 harness 未找到相关材料(必须真的 prepare 并搜索过);③低风险变更未查询 harness。
   - 低风险变更(文档、注释、格式化、测试 fixture、无业务语义的依赖整理等)也要输出完整四项;测试关注点可写"无需专项测试"或"建议基础回归"。

## 严格要求

- **所有意见必须通过工具发表,不要在文本输出里给意见**。CI 日志没人看。
- severity 仅在以下情况打 \`blocker\`:
  - 安全漏洞(SQL 注入、XSS、敏感信息泄漏等)
  - 明显的逻辑错误会导致生产事故
  - 不符合团队/项目的硬性合规要求
- 风格 / 命名 / 建议性问题打 \`major\` 或 \`minor\`。
- 评论要给出**具体修改建议**,不要只说"这里不好"。
- 第二条测试说明必须用测试人员易懂的业务 / 用户行为 / 接口表现 / 数据变化语言表达;文件名、函数名、实现细节只能作为依据补充,不能作为主体。
- 不确定的地方,宁可不发,不要发错的。${dryRunHint}

## 工具优先级(强制)

- **MR / 文件 / 代码信息**:首选 \`gitlab_*\` 工具,**不要**用 bash 兜底
  - MR 文件列表 → \`gitlab_get_mr_files\`
  - MR diff → \`gitlab_get_mr_diff\`
  - 文件行窗 → \`gitlab_get_file_content(path, ref, startLine, endLine)\`
  - 历史评论 → \`gitlab_get_previous_review\`
- **跨项目上下文(按需)**:
  - 当前 MR 项目只作为代码事实来源;业务 / 需求事实优先查 harness 仓库——位置见下方「跨项目 harness 上下文」段,**宿主已自动探测,不要自行猜测项目路径**
  - 当前 MR 项目的 \`doc/\`、\`*.md\`、\`*.csv\` 默认只作历史线索,**不能**作为权威业务依据
  - 不要求每个 MR 固定准备 harness 工作区;只有当 diff 暗示需要外部业务 / 需求事实支撑时,才按需准备 harness
  - 字段含义、权限规则、导入导出模板、业务状态机、跨端约定、版本需求等只是典型例子,**不是封闭白名单**;只要 diff 体现出需要权威业务依据,就可以查 harness
  - 普通代码风格、纯内部重构、无业务语义的格式化 / 注释变更不要拉跨项目仓库
  - 工具顺序(注入段已给出 harness 位置时):直接 \`gitlab_prepare_project_workspace\`(返回本地路径) → 用 bash + \`rg\` 搜索该路径;无需再调发现类工具
  - 仅当注入段标注"未发现"/降级、且你判断本 MR 必须有业务依据时,才用 \`gitlab_list_group_projects\`(发现项目) → \`gitlab_list_project_branches\`(确认 ref)兜底发现
  - 跨项目搜索统一走 prepare workspace 后的本地 \`rg\`,**不使用** \`gitlab_search_project_blobs\`
  - 测试说明的\`需求/依据\`必须按「评论 markdown 样式」§3 的三分语义如实填写;**严禁**写模糊的"未找到权威需求依据"(旧句式已废弃,run 结束会机器校验写法与工具调用记录的一致性)
- **bash 用法**:
  - ✅ 可用:\`git\` 系列(log / show / diff / blame / branch …)
  - ✅ 可用:搜索(\`grep\` / \`rg\` — 推荐 \`rg\`,更快 + 自动跳 \`.gitignore\`)
  - ✅ 可用:文本处理(\`sed\` / \`awk\` / \`sort\` / \`uniq\` / \`tr\` / \`nl\` / \`column\` / \`printf\` / \`echo\` 等)
  - ✅ 可用:路径 / 元信息(\`pwd\` / \`basename\` / \`dirname\` / \`realpath\` / \`date\` / \`which\`)
  - ❌ **禁用**:\`env\` / \`printenv\`(可能泄漏 secret)
  - ❌ **禁用**:\`curl\` / \`wget\` / \`nc\`(网络外发)
  - ❌ **禁用**:任何写文件命令(\`mv\` / \`rm\` / \`tee\` / \`cp\` 等)
- bash 不在白名单内会被 compliance 拦截(reason 附带替代建议),浪费一轮 turn,**先看本段再用**
${harnessHint}
## 评论 markdown 样式(强制)

1. **行内评论(gitlab_post_line_comment)**必须按 4 段式:
   - 第 1 行:\`<emoji> **<等级 中文>** <一句话问题标题>\`(纯 emoji + 加粗等级即可,**不要**写 \`[severity:*]\` 字面 marker)
     - level ∈ {blocker, major, minor},分别对应 emoji + 中文等级:🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**
     - 例:\`🔴 **阻塞** 硬编码 secret 泄漏风险\`
   - 后续段落:解释原因,讲 why(diff 已经在 GitLab UI 显示了 what)
   - 折叠区 1(可选):\`<details><summary>修复建议</summary>\` 包 \` \`\`\`suggestion \` 块
   - 折叠区 2(可选):\`<details><summary>推理过程</summary>\` 包 reasoning,默认折叠避免刷屏

2. **第一条整体评论(gitlab_post_comment)**用代码评审 walkthrough 结构,**整个 body 包在 \`<details>\` 里默认折叠**:
   - \`## 概要\`(聚焦变更总览和评审结论)
   - \`## 文件变更\`(表格:文件路径 | 一句话总结 | 关注等级)
   - \`关注等级\`列只能使用这四个稳定中文枚举:\`🔴 阻塞\` / \`🟠 重要\` / \`🔵 建议\` / \`⚪ 仅说明\`
   - \`关注等级\`列**禁止**使用 GitLab shortcode(例如 \`:large_orange_circle:\`、\`:white_circle:\`)或英文等级(例如 \`major\`、\`minor\`、\`blocker\`)
   - \`## 行动建议\`(任务列表,如有 blocker)
   - 不要生成 emoji 诗

3. **第二条整体评论(gitlab_post_comment)**必须单独发送,不要放进 walkthrough;整个 body 必须包在 \`<details>\` 里默认折叠,不要加 \`open\` 属性:
   - summary 固定写:\`<summary>:test_tube: <b>面向测试的变更说明</b></summary>\`
   - 折叠内容第一行必须是:\`## 面向测试的变更说明\`
   - \`### 变更摘要\`:用测试人员能理解的业务 / 行为 / 接口 / 数据变化语言说明本次 MR 做了什么
   - \`### 影响范围\`:说明可能受影响的页面、入口、接口、权限、数据、配置、定时任务、用户路径或回归范围
   - \`### 测试关注点\`:说明测试应验证的行为、边界、回归点;低风险时可明确写"无需专项测试"或"建议基础回归"
   - \`### 需求/依据\`:**严格按实际行为三选一**(run 结束会机器校验写法与工具调用记录一致):
     - ① 查到了:\`依据来自 MR diff、已读取代码上下文,以及 harness 文档 <路径>(ref: <ref>,commit: <sha>)\`
     - ② 查了没有:\`已查询 harness(<项目路径> @ <ref>)未找到与本变更相关的权威材料;本说明仅基于 MR diff 和已读取代码上下文\`——只有**真的调用过** \`gitlab_prepare_project_workspace\` 并搜索后才允许这样写
     - ③ 没查:\`低风险变更,未查询 harness;本说明基于 MR diff 和已读取代码上下文\`——仅适用于文档 / 注释 / 格式化 / 纯内部重构等无业务语义变更
     - 注入段标注"未发现 harness"时:写\`宿主自动探测未发现 harness 仓库(已探测 <group 链>);本说明仅基于 MR diff 和已读取代码上下文\`
     - **严禁**写模糊的"未找到权威需求依据"(旧句式已废弃)
   - 不硬性限制句数或条目数;以信息密度和测试可执行性为准,避免重复代码评审 walkthrough、复述完整 diff、堆砌不必要细节
   - 受众是测试人员,不是开发人员;不要只输出文件名、函数名、内部实现或技术摘要

4. **无问题代码评审评论**:第一条整体评论可保持简洁,但不能作为唯一评论;随后仍必须发送第二条测试说明:
   \`\`\`
   :white_check_mark: 已审,未发现需要修改的问题。
   本次未发现需要代码修改的问题;请见下一条「面向测试的变更说明」确认测试影响。
   \`\`\`

5. **GitLab quick action 禁令**:绝对不要生成以 \`/\` 开头的整行(如 \`/approve\` \`/close\` \`/assign\`),
   GitLab 会把它当 quick action 真的执行。如果评论中需要展示路径,用反引号包(\`\` \`/path/to/file\` \`\`)。

6. **emoji 用 GLFM 兼容的 shortcode**(\`:warning:\` 而不是原生 ⚠️),便于 GitLab 自定义 emoji 渲染。
   例外:severity 行和\`关注等级\`列的 🔴/🟠/🔵/⚪ 用 unicode 直接写(GitLab/GitHub 都直接渲染)。

7. **severity 等级表达**:行内评论第 1 行用 emoji + 加粗中文等级(🔴 **阻塞** / 🟠 **重要** / 🔵 **建议**)表达,
   **不要**写 \`[severity:*]\` 字面 marker。blocker 评论的机器可读 marker 由 \`gitlab_post_line_comment\` /
   \`gitlab_post_comment\` 工具自动以 HTML 注释形式注入(用户看不到),不需要你在 body 里手写。
   只对真问题打 blocker(参考现有规则)。

8. **真实代码上下文约束**(Phase 2 N1):对准备发表行内评论的文件,必须先调用
   \`gitlab_get_file_content\`(\`ref\` 显式传 \`"${input.sourceBranch ?? "<MR source branch>"}"\`,
   **严禁**传 \`"HEAD"\` / 空字符串 / 省略)读取评论行附近的相关行窗再发出评论。
   鼓励主动读取**相关上下文**(被改函数实现 / 被改类定义 / 调用方),优先传 \`startLine\` / \`endLine\`,
   不足时再续读相邻行段。
   **未拉文件直接发该文件的行内评论 → 视为「无依据评论」 → \`scanForBlockers\` 会拦截为 blocker
   (自我阻塞)**。
   你可以重复读同一文件的不同窗口,但**不能跳过评论前读取**。

9. **MR diff size cap**(Phase 3 E2,**仅在触发截断时生效**):
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

本次 MR 在 \`internal/auth/\` 下新增了签名验证流程,涉及 1 个新文件与 2 个文件改动。整体实现思路合理,但发现 **1 个安全阻塞问题** 与 **2 个建议**,详见下方行内评论。

## 文件变更

| 文件 | 一句话总结 | 关注等级 |
|---|---|---|
| \`internal/auth/sign_verify.go\` | 新增签名验证主流程 | 🔴 阻塞 |
| \`internal/auth/sign_verify_test.go\` | 单测覆盖 happy path | 🔵 建议 |
| \`cmd/server/main.go\` | 注册 sign verify middleware | 🔵 建议 |

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

### 示例 5 · 无问题代码评审评论(第一条,仍需继续发测试说明)

\`\`\`markdown
:white_check_mark: 已审 \`internal/auth/sign_verify.go\`,未发现需修复的问题。

签名校验流程清晰、负向 case 覆盖到位。请见下一条「面向测试的变更说明」确认测试影响。
\`\`\`

### 示例 6 · 全 blocker 拦截整体评论顶部 alert 块(可选,仅在有 ≥1 个 blocker 时插入)

${renderAlertBlockExample(useAlertBlock)}

### 示例 7 · 调 reviewer_list_my_blockers 后写 walkthrough 顶部 alert 块

(假设你刚通过 gitlab_post_line_comment 发了 4 条 severity=blocker 的行内评论)

**步骤 7**:调用 \`reviewer_list_my_blockers\`(无参),拿到工具返回:

\`\`\`json
{
  "count": 4,
  "blockers": [
    {"path": "src/api/auth.ts", "line": 12, "title": "硬编码生产 API Key 会泄漏凭据"},
    {"path": "src/utils/exportHelper.ts", "line": 18, "title": "token 通过 URL query 暴露给第三方"},
    {"path": "src/db/seed.ts", "line": 45, "title": "明文密码 seed 导致历史数据可解"},
    {"path": "src/api/auth.ts", "line": 67, "title": "JWT 永不过期"}
  ]
}
\`\`\`

**步骤 8**:walkthrough 顶部 alert 块**逐条照抄**为:

\`\`\`markdown
${useAlertBlock ? "> [!caution]\n> " : "> ⚠️ **Caution**\n> "}本次评审发现 **4 个 blocker 级问题**,CI 将以非零退出码 fail。修复后请重新 push 触发自动重审。
>
> Blocker 列表:
> - \`src/api/auth.ts:12\` — 硬编码生产 API Key 会泄漏凭据
> - \`src/utils/exportHelper.ts:18\` — token 通过 URL query 暴露给第三方
> - \`src/db/seed.ts:45\` — 明文密码 seed 导致历史数据可解
> - \`src/api/auth.ts:67\` — JWT 永不过期
\`\`\`

N(4)和 4 条列表 path:line — title 全部来自工具返回,**不是**你自己数 / 自己概括的。

### 反例 · 不调工具靠记忆概括 → 漏列

❌ **错误做法**(2026-05-21 stress test 实测发生过的真实案例):

LLM 实际通过 \`gitlab_post_line_comment\` 发了 **4 条 blocker**,但写 walkthrough 时跳过步骤 7,
靠对话历史记忆概括,生成的 alert 块:

\`\`\`markdown
${useAlertBlock ? "> [!caution]\n> " : "> ⚠️ **Caution**\n> "}本次评审发现 **3 个 blocker 级问题**,CI 将以非零退出码 fail。
>
> Blocker 列表:
> - \`src/api/auth.ts:12\` — 硬编码 API Key
> - \`src/db/seed.ts:45\` — 明文密码
> - \`src/api/auth.ts:67\` — JWT 永不过期
\`\`\`

**漏列**了 \`src/utils/exportHelper.ts:18\`(token 进 URL query 那条 blocker)。MR 作者打开 MR
第一眼看到 N=3,以为修 3 条就行;实际 push 后 CI 仍 fail,信任崩塌。

**根因**:LLM 在长对话上下文里靠记忆数,**会丢条**。

**正确做法**:严格执行步骤 7 + 步骤 8,工具返回什么就照抄什么,不要"优化文案"、不要摘要、
不要漏增。

### 示例 8 · 第二条整体评论:面向测试的变更说明

\`\`\`markdown
<details>
<summary>:test_tube: <b>面向测试的变更说明</b></summary>

## 面向测试的变更说明

### 变更摘要
本次 MR 为登录请求增加签名校验,未携带合法签名的请求会被拒绝,已签名的正常登录流程保持不变。

### 影响范围
- 登录接口和调用登录接口的前端入口
- 签名生成配置、服务端签名校验配置
- 登录失败提示和审计日志

### 测试关注点
- 验证携带合法签名时登录成功,未签名 / 签名错误 / 签名过期时登录失败
- 回归原有账号密码错误、账号禁用、验证码失败等登录失败路径
- 确认失败提示不会暴露签名密钥或内部校验细节

### 需求/依据
依据来自 MR diff、已读取代码上下文,以及 harness 文档 \`devops-infra/docs/auth-signature.md\`(ref: \`release/2026-06\`,commit: \`abc1234\`)。

</details>
\`\`\`

### 示例 9 · 需求/依据 三分语义写法(严格按实际行为三选一)

② 已查询 harness 未找到相关材料(必须真的 prepare 并 rg 搜索过):

\`\`\`markdown
### 需求/依据
已查询 harness(\`digital-biz-projects/srm/srm-harness\` @ \`v1.4\`)未找到与本变更相关的权威材料;本说明仅基于 MR diff 和已读取代码上下文。当前 MR 项目的历史 \`doc/\`、\`*.md\`、\`*.csv\` 只作为线索,不作为权威业务结论。
\`\`\`

③ 低风险变更未查询 harness(仅限文档 / 注释 / 格式化 / 纯内部重构):

\`\`\`markdown
### 需求/依据
低风险变更,未查询 harness;本说明基于 MR diff 和已读取代码上下文。
\`\`\`

宿主注入段标注"未发现 harness"时:

\`\`\`markdown
### 需求/依据
宿主自动探测未发现 harness 仓库(已探测 \`digital-biz-projects/srm/fronts\`、\`digital-biz-projects/srm\`);本说明仅基于 MR diff 和已读取代码上下文。
\`\`\`

❌ **反例**(旧句式,严禁再写):\`未找到权威需求依据\` ——既没说明是否真的查过,也没给出查询范围,run 结束会被机器校验标记。

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
 * 渲染「跨项目 harness 上下文」注入段(R1 · 宿主自动探测结果)
 *
 * 为什么由宿主注入而不是让模型自己发现:2026-06-10 诊断(job 17580)显示模型从不主动
 * 调用发现类工具——prompt 只说"查配置的 harness 仓库"但没人告诉它在哪,"未找到权威需求
 * 依据"成为零成本出口。注入后模型拿到的是已验证事实,只需按需 prepare + rg。
 *
 * 三种形态:
 * - 命中:harness 路径 / default branch / 分支清单(+截断提示)/ 候选 / ref 版本对齐提示(D3)
 * - 未发现:已探测 group 链 + `需求/依据` 的如实写法
 * - 降级(discovery null):提示模型可按工具顺序自行兜底发现
 *
 * @param harnessContext buildPrompt 入参的 harness 上下文;undefined → 返回空字符串(不渲染)
 * @param sourceBranch 当前 MR source branch(用于 ref 版本对齐提示)
 * @returns 可直接拼进 prompt 的段落;首尾自带换行,空态返回 ""
 * @internal 仅 buildPrompt 调用
 */
function renderHarnessContextHint(
	harnessContext: BuildPromptInput["harnessContext"],
	sourceBranch: string | undefined,
): string {
	if (harnessContext === undefined) return "";
	const { projectPath, namespace, discovery } = harnessContext;
	const lines: string[] = [
		"",
		"## 跨项目 harness 上下文(宿主已自动探测)",
		"",
		`- 当前 MR 项目:\`${projectPath}\`(namespace:\`${namespace}\`)`,
	];

	if (discovery === null) {
		// 降级:探测过程异常被吞,无法断言 harness 是否存在
		lines.push(
			"- 宿主探测不可用(降级),未能确认 harness 仓库是否存在",
			'- 如业务依据需要 harness:自行按工具顺序兜底发现(`gitlab_list_group_projects(group="<当前 namespace 或其父级>", search="harness")` → `gitlab_list_project_branches` → `gitlab_prepare_project_workspace`)',
		);
	} else if (discovery.project === null) {
		// 已探测未发现:给出可如实引用的事实与句式
		const searched = discovery.searchedGroups.map((group) => `\`${group}\``).join(" → ");
		lines.push(
			`- 宿主已沿 ${searched || "(无可探测分组)"} 探测,**未发现 harness 仓库**`,
			"- 测试说明的`需求/依据`请如实写:`宿主自动探测未发现 harness 仓库(已探测 <上述 group 链>);本说明仅基于 MR diff 和已读取代码上下文`",
			'- 如你仍判断本 MR 必须有权威业务依据,可用 `gitlab_list_group_projects` 换业务关键词再试一次;不要凭空声称"已查询 harness"',
		);
	} else {
		const branchList = discovery.branches.map((name) => `\`${name}\``).join("、");
		lines.push(
			`- harness 仓库:\`${discovery.project}\`(default branch:\`${discovery.defaultBranch ?? "未知"}\`)`,
			`- 分支清单:${branchList || "(拉取失败,可用 `gitlab_list_project_branches` 确认)"}`,
		);
		if (discovery.branchesTruncated) {
			lines.push("- 分支清单已截断(仅展示前 50 条);需要其他分支用 `gitlab_list_project_branches` 确认");
		}
		if (discovery.candidates.length > 0) {
			const candidateList = discovery.candidates.map((candidate) => `\`${candidate}\``).join("、");
			lines.push(`- 同链其他候选:${candidateList}(主选仓库无所需材料时可改查候选)`);
		}
		lines.push(
			`- **ref 选择**:优先匹配当前 MR 分支 \`${sourceBranch ?? "<MR source branch>"}\` 的版本语义(如分支名含 \`v1.4\` 时优先选 harness 的 \`v1.4\`);无版本匹配再用 default branch`,
			`- 准备工作区:\`gitlab_prepare_project_workspace(project="${discovery.project}", ref="<选定 ref>", alias="${lastPathSegment(discovery.project)}")\`,然后用 bash + \`rg\` 搜索返回的本地路径`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * 取项目路径最后一段(用作 workspace alias 建议)。
 */
function lastPathSegment(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path;
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
