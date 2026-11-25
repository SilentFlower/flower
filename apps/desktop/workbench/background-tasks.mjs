const tasksPerSession = 24;
const statuses = new Set([
	"queued",
	"running",
	"cancelling",
	"succeeded",
	"failed",
	"denied",
	"cancelled",
	"interrupted",
]);

function excerpt(value) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 240) : "";
}

/**
 * 提取后台任务面板所需的有界摘要。工作区身份由会话所有者复核。
 * @param snapshot 运行时保存的会话快照
 * @returns 最近请求的任务摘要
 */
export function summarizeBackground(snapshot) {
	const requests = Array.isArray(snapshot?.requests) ? snapshot.requests : [];
	return requests
		.slice(-tasksPerSession)
		.filter((request) => statuses.has(request?.status))
		.map((request) => ({
			id: request.requestId,
			workspaceId: request.workspaceId,
			input: excerpt(snapshot.desktopMessages?.[request.requestId]?.input ?? request.input),
			result: excerpt(request.text) || excerpt(request.failure?.message),
			progress: Array.isArray(request.steps) ? excerpt(request.steps.findLast((step) => !step.endedAt)?.target) : "",
			status: request.status,
			at: request.endedAt ?? request.startedAt ?? 0,
		}));
}

/**
 * 根据本机快照、会话排队和仍在运行的任务计算右栏状态。
 * @param tasks 已持久化的任务摘要
 * @param queued 会话中尚未交给运行时的请求
 * @param state 会话授权和当前运行状态
 * @returns 同一会话的任务和真实状态
 */
export function mergeBackground(tasks, queued, { workspaceId, active, approvals, questions, paused }) {
	const history = tasks
		.filter((task) => task.workspaceId === workspaceId)
		.map((task) => ({
			...task,
			status: approvals.has(task.id)
				? "waiting-write"
				: questions && active.has(task.id)
					? "waiting-answer"
					: ["queued", "running", "cancelling"].includes(task.status) && !active.has(task.id)
						? "interrupted"
						: task.status,
		}));
	return [
		...history,
		...queued.map((task) => ({
			id: task.id,
			input: excerpt(task.input),
			result: "",
			status: paused ? "paused" : "queued",
			at: task.createdAt || 0,
		})),
	];
}

/**
 * 运行中的项目优先，已结束项目按时间倒序。
 * @param tasks 后台任务行
 * @returns 最多 80 条后台任务
 */
export function recentBackground(tasks) {
	const ongoing = new Set([
		"queued",
		"starting",
		"waiting-model",
		"running",
		"cancelling",
		"paused",
		"waiting-answer",
		"waiting-write",
	]);
	return tasks.sort((a, b) => Number(ongoing.has(b.status)) - Number(ongoing.has(a.status)) || b.at - a.at).slice(0, 80);
}
