import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";

const active = new Set(["queued", "starting", "running", "cancelling"]);
const terminal = new Set(["succeeded", "failed", "denied", "cancelled", "interrupted", "missed"]);
const permissions = new Set(["read", "ask", "auto"]);

/**
 * 求给定本地时刻最近一次到期的计划时刻。
 * @param plan 日或周计划
 * @param now 当前毫秒时间戳
 * @returns 最近的到期时间和是否为有效本地钟点
 */
export function latestScheduleSlot(plan, now) {
	const date = new Date(now);
	const [hour, minute] = plan.time.split(":").map(Number);
	const offset = plan.frequency === "weekly" ? (date.getDay() + 7 - plan.weekday) % 7 : 0;
	date.setDate(date.getDate() - offset);
	date.setHours(hour, minute, 0, 0);
	if (date.getTime() > now) {
		date.setDate(date.getDate() - (plan.frequency === "weekly" ? 7 : 1));
		date.setHours(hour, minute, 0, 0);
	}
	return { at: date.getTime(), valid: date.getHours() === hour && date.getMinutes() === minute };
}

function planInput(value) {
	const { workspaceId, title, prompt, frequency, time, weekday, writeMode, skill } = value ?? {};
	if (
		typeof workspaceId !== "string" ||
		!workspaceId ||
		typeof title !== "string" ||
		!title.trim() ||
		title.trim().length > 120 ||
		typeof prompt !== "string" ||
		!prompt.trim() ||
		prompt.length > 16000 ||
		!["daily", "weekly"].includes(frequency) ||
		typeof time !== "string" ||
		!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) ||
		time.length !== 5 ||
		(frequency === "weekly" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) ||
		!permissions.has(writeMode) ||
		(skill !== undefined && (typeof skill !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)))
	)
		throw new Error("请填写有效的标题、工作区、任务和执行时刻。");
	return {
		workspaceId,
		title: title.trim(),
		prompt,
		frequency,
		time,
		weekday: frequency === "weekly" ? weekday : 0,
		writeMode,
		...(skill && { skill }),
	};
}

function newRun(plan, at, trigger, status) {
	const id = randomUUID();
	return {
		id,
		plan: plan.id,
		workspaceId: plan.workspaceId,
		title: plan.title,
		prompt: plan.prompt,
		writeMode: plan.writeMode,
		...(plan.skill && { skill: plan.skill }),
		at,
		trigger,
		status,
	};
}

/**
 * 持久化自动化计划和运行账本，恢复记录，向现有运行时派发新任务。
 * @param options 保存文件和工作台的运行、取消、恢复回调
 * @returns 加载、调度和管理计划的入口
 */
export function createAutomation({ path, workspace, available, launch, abort, recover, changed, clock = Date.now }) {
	let data = { plans: [], runs: [] };
	let pending = Promise.resolve();
	let loading;
	let closed = false;
	let draining;
	let wakeRequested = false;
	const starts = new Map();

	function view() {
		return { plans: data.plans.map(({ cursor, ...plan }) => plan), runs: [...data.runs].reverse() };
	}

	async function save(next) {
		// 历史采用有界保留，未结束的任务保留到收敛。
		const old = next.runs.filter(({ status }) => !active.has(status));
		const recent = new Set(old.slice(-200).map(({ id }) => id));
		next.runs = next.runs.filter(({ id, status }) => active.has(status) || recent.has(id));
		await writeJson(path, next);
		data = next;
		changed();
	}

	function mutate(action) {
		const operation = pending.then(async () => {
			if (closed) throw new Error("工作台正在关闭。");
			await load();
			const next = structuredClone(data);
			const result = await action(next);
			if (result !== false) await save(next);
			return result;
		});
		pending = operation.catch(() => {});
		return operation;
	}

	function settleOld(next, now, startup) {
		let changed = false;
		for (const plan of next.plans) {
			if (!plan.enabled) continue;
			const slot = latestScheduleSlot(plan, now);
			if (slot.at <= plan.cursor) continue;
			plan.cursor = slot.at;
			const already = next.runs.some((run) => run.plan === plan.id && active.has(run.status));
			const status = startup || !slot.valid || already || now - slot.at >= 60000 ? "missed" : "queued";
			const run = newRun(plan, slot.at, "scheduled", status);
			if (status === "missed") run.result = already ? "上一次任务尚未结束。" : "应用在这个时刻无法启动任务。";
			next.runs.push(run);
			changed = true;
		}
		return changed;
	}

	function load() {
		loading ??= (async () => {
			const stored = await readJson(path);
			if (!stored) return;
			if (!Array.isArray(stored.plans) || !Array.isArray(stored.runs)) throw new Error("无法读取已保存的自动化计划。");
			let dirty = false;
			for (const run of stored.runs) {
				if (!active.has(run.status)) continue;
				const history = await recover(run).catch(() => undefined);
				run.status = terminal.has(history?.status) ? history.status : "interrupted";
				run.result = history?.result || (run.status === "interrupted" ? "上次运行已中断。" : "");
				if (history?.request) run.request = history.request;
				dirty = true;
			}
			if (settleOld(stored, clock(), true)) dirty = true;
			if (dirty) await save(stored);
			else data = stored;
		})();
		return loading;
	}

	function requirePlan(next, id) {
		const plan = next.plans.find((entry) => entry.id === id);
		if (!plan) throw new Error("找不到这项自动化。");
		return plan;
	}

	function update(id, apply) {
		return mutate((next) => {
			const run = next.runs.find((entry) => entry.id === id);
			return run ? apply(run) : false;
		});
	}

	function drain() {
		if (closed || !available()) return draining;
		wakeRequested = true;
		if (draining) return draining;
		draining = (async () => {
			while (!closed && available()) {
				wakeRequested = false;
				const run = await mutate((next) => {
					const first = next.runs.find(({ status }) => status === "queued");
					if (!first) return false;
					first.status = "starting";
					return first;
				});
				if (!run || closed) break;
				const controller = new AbortController();
				starts.set(run.id, controller);
				try {
					const accepted = await launch(run, controller.signal);
					await update(run.id, (saved) => {
						saved.request = accepted.requestId;
						if (saved.status === "starting") saved.status = "running";
					});
				} catch (error) {
					await update(run.id, (saved) => {
						if (!active.has(saved.status)) return false;
						saved.status = controller.signal.aborted ? "cancelled" : "failed";
						saved.result = controller.signal.aborted ? "" : String(error?.message || "任务无法启动。").slice(0, 240);
					});
				} finally {
					starts.delete(run.id);
				}
			}
		})()
			.catch(() => {})
			.finally(() => {
				draining = undefined;
				// 队列判空后仍可能收到一次唤醒，退出时转交给下一轮。
				if (wakeRequested) return drain();
			});
		return draining;
	}

	return {
		load,
		async view() {
			await load();
			return view();
		},
		async tick() {
			await mutate((next) => settleOld(next, clock(), false));
			await drain();
		},
		drain,
		async savePlan(id, input) {
			const fields = planInput(input);
			workspace(fields.workspaceId);
			const result = await mutate((next) => {
				const prior = id ? requirePlan(next, id) : undefined;
				const slot = latestScheduleSlot(fields, clock());
				const plan = { ...fields, id: prior?.id ?? randomUUID(), enabled: prior?.enabled ?? true, cursor: slot.at };
				if (prior) next.plans[next.plans.indexOf(prior)] = plan;
				else next.plans.push(plan);
				return plan.id;
			});
			return result;
		},
		async enable(id, enabled) {
			if (typeof enabled !== "boolean") throw new Error("启用状态无效。");
			await mutate((next) => {
				const plan = requirePlan(next, id);
				if (plan.enabled === enabled) return false;
				plan.enabled = enabled;
				plan.cursor = latestScheduleSlot(plan, clock()).at;
			});
		},
		async remove(id) {
			await mutate((next) => {
				requirePlan(next, id);
				next.plans = next.plans.filter((plan) => plan.id !== id);
			});
		},
		async runNow(id) {
			const run = await mutate((next) => {
				const plan = requirePlan(next, id);
				workspace(plan.workspaceId);
				if (next.runs.some((run) => run.plan === id && active.has(run.status)))
					throw new Error("上一次任务仍在运行或等待。");
				const run = newRun(plan, clock(), "manual", "queued");
				next.runs.push(run);
				return run;
			});
			void drain();
			return run.id;
		},
		async cancel(id) {
			const affected = await update(id, (run) => {
				if (!active.has(run.status) || run.status === "cancelling") throw new Error("任务当前无法取消。");
				const stopping = starts.get(id);
				stopping?.abort(new Error("用户取消任务。"));
				if (run.status === "queued") run.status = "cancelled";
				else run.status = "cancelling";
				return { ...run };
			});
			if (!affected) throw new Error("找不到这次运行。");
			if (affected.status === "cancelling") await abort(affected).catch(() => {});
		},
		finish(id, status, result, request) {
			if (!terminal.has(status)) return Promise.resolve(false);
			return update(id, (run) => {
				if (!active.has(run.status)) return false;
				run.status = status;
				run.result = typeof result === "string" ? result.slice(0, 240) : "";
				if (request) run.request = request;
			});
		},
		close() {
			closed = true;
			for (const controller of starts.values()) controller.abort();
		},
	};
}
