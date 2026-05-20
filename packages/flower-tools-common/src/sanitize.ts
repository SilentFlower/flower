/**
 * 评论 body 安全清洗工具(防 GitLab quick action 误触发)
 *
 * 为什么独立成 module:
 * - quick action 误触发是跨 GitLab 工具的通用风险(MR / Issue / Epic 评论都会执行 quick action)
 * - 任何调 GitLab 评论 API 的下游都应能复用本函数(flower-tools-gitlab / 未来 auto-fix bot 等)
 * - 与具体 GitLab REST 客户端解耦,纯字符串处理,便于单测覆盖
 *
 * 背景:
 * GitLab MR / Issue 评论里以 `/` 起头的行会被 GitLab 服务端解读为 **quick action**,
 * 自动执行对应操作(`/approve` 真的批准 MR、`/close` 真的关闭、`/assign @x` 真的派单)。
 *
 * 即使我们在 prompts.ts 用硬约束禁止 LLM 输出此类行,**仍需 post-time 防御纵深** —
 * 万一 LLM 在 reasoning 折叠区里贴了 `/approve` 字面量(讨论"为什么不该用 /approve"),
 * 也会被 GitLab 误触发。本函数对 quick action 行做行级转义,在 post 前最后一道关。
 *
 * 转义方式:首字符 `/` → `&#47;`(HTML numeric entity,GitLab Markdown 渲染时显示为字面 `/`)
 *
 * 参考:
 * - GitLab Quick Actions 文档:https://docs.gitlab.com/user/project/quick_actions/
 * - research/comment-style.md §4.1 「Quick Actions:bot 必须避开的"地雷"」
 */

/**
 * GitLab 已知 quick action 关键字
 *
 * 来源:`research/comment-style.md` §4.1 + GitLab 18.10 文档 + 实际生产中可能出现的常用 action。
 *
 * 注:此列表覆盖**评论模式**下可触发的 action 子集(以 `/` 起头的常见命令)。
 * 若 GitLab 新版本加入新 quick action 名,需同步更新本列表。
 *
 * 选择依据(全量覆盖触发 MR 状态变更的 action,即使本仓不直接用也防御):
 * - 批准 / 关闭类:`approve`/`unapprove`/`close`/`reopen`/`wip`/`draft`/`unwip`
 * - 派单类:`assign`/`unassign`/`reassign`/`assignee`/`reviewer`/`request_review`/`unassign_reviewer`
 * - 标签 / 里程碑:`label`/`unlabel`/`relabel`/`labels`/`milestone`/`remove_milestone`
 * - 截止 / 工时:`due`/`remove_due_date`/`spend`/`spent`/`unspend`/`estimate`/`remove_estimate`/`remove_time_spent`
 * - 锁 / 合并:`lock`/`unlock`/`merge`/`rebase`
 * - 订阅 / 隐私:`subscribe`/`unsubscribe`/`confidential`/`unconfidential`
 * - 待办 / 标签:`todo`/`done`/`tag`/`copy_metadata`
 * - 引用 / 表情:`cc`/`shrug`/`tableflip`/`award`/`react`
 * - 标题 / 内容:`title`/`description`
 * - 其他:`zoom`/`remove_zoom`/`target_branch`/`promote`/`promote_to_incident`/`duplicate`
 */
const QUICK_ACTIONS: readonly string[] = [
	// approve / close 类
	"approve",
	"unapprove",
	"close",
	"reopen",
	"wip",
	"draft",
	"unwip",
	// assign / reviewer 类
	"assign",
	"unassign",
	"reassign",
	"assignee",
	"reviewer",
	"request_review",
	"unassign_reviewer",
	// label / milestone 类
	"label",
	"unlabel",
	"relabel",
	"labels",
	"milestone",
	"remove_milestone",
	// 时间 / 工时类
	"due",
	"remove_due_date",
	"spend",
	"spent",
	"unspend",
	"estimate",
	"remove_estimate",
	"remove_time_spent",
	// 锁 / 合并类
	"lock",
	"unlock",
	"merge",
	"rebase",
	// 订阅 / 隐私类
	"subscribe",
	"unsubscribe",
	"confidential",
	"unconfidential",
	// 待办 / 标签类
	"todo",
	"done",
	"tag",
	"copy_metadata",
	// 引用 / 表情类
	"cc",
	"shrug",
	"tableflip",
	"award",
	"react",
	// 标题 / 描述类
	"title",
	"description",
	// 其他
	"zoom",
	"remove_zoom",
	"target_branch",
	"promote",
	"promote_to_incident",
	"duplicate",
];

/**
 * Quick action 整行匹配正则
 *
 * - `^/` 必须行首
 * - `(${QUICK_ACTIONS.join('|')})` 任一已知 action 关键字
 * - `(\\s|$)` 关键字后必须是空白(`/approve @x`)或行尾(`/approve`),
 *   避免误伤诸如 `/approveBucket` 这类业务路径
 * - `i` 大小写不敏感(`/APPROVE` 也拦截,虽然 GitLab 实测是大小写敏感的,
 *   保守起见多兜一层,避免 LLM 不小心写错大小写仍触发)
 *
 * @internal
 */
const QUICK_ACTION_REGEX = new RegExp(`^/(${QUICK_ACTIONS.join("|")})(\\s|$)`, "i");

/**
 * 转义评论 body 中以 GitLab quick action 关键字起头的行
 *
 * 行为:
 * - 按 `\n` 拆行,逐行检查
 * - 命中 quick action 正则 → 首字符 `/` 替换为 `&#47;`(其余内容不动)
 * - 不命中 → 原样保留
 * - 已转义的 `&#47;approve` 不会二次转义(因为首字符已经是 `&` 不是 `/`)
 *
 * 不处理:
 * - 行中间出现 `/approve`(如反引号 `` `/approve` `` 引用)→ 不触发 GitLab quick action,无需转义
 * - 普通路径引用(`/path/to/file.ts` 单独成行)→ 不属于 quick action,**不会**误转义(因关键字 \\s 边界)
 *
 * @param body 评论 markdown body(可能包含多行)
 * @returns 已转义的 body(无 quick action 行时与输入相同)
 */
export function sanitizeQuickActions(body: string): string {
	return body
		.split("\n")
		.map((line) => (QUICK_ACTION_REGEX.test(line) ? `&#47;${line.slice(1)}` : line))
		.join("\n");
}
