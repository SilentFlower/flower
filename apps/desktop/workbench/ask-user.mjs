const idPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const questionLimit = 4;
const optionLimit = 6;
const questionLength = 360;
const optionLength = 120;

function questionText(value, limit) {
	if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("提问文字为空或超出长度。");
	return value.trim();
}

function checkedQuestions(items) {
	if (!Array.isArray(items) || !items.length || items.length > questionLimit)
		throw new Error("一次可提出 1 至 4 个问题。");
	return Array.from(items, (item) => {
		if (
			!Array.isArray(item?.options) ||
			item.options.length < 2 ||
			item.options.length > optionLimit ||
			(item.multiple !== undefined && typeof item.multiple !== "boolean")
		)
			throw new Error("每个问题应提供 2 至 6 个选项，并明确是否允许多选。");
		const options = Array.from(item.options, (value) => questionText(value, optionLength));
		if (new Set(options).size !== options.length) throw new Error("同一个问题的选项不能重复。");
		return { question: questionText(item.question, questionLength), options, multiple: item.multiple === true };
	});
}

function questionResult(questions, selection) {
	if (selection === null) return { status: "skipped" };
	if (!Array.isArray(selection) || selection.length !== questions.length)
		throw new Error("请回答每个问题，或跳过本次提问。");
	const answers = questions.map(({ question, options, multiple }, index) => {
		const values = selection[index];
		if (
			!Array.isArray(values) ||
			!values.length ||
			values.length > (multiple ? options.length : 1) ||
			new Set(values).size !== values.length
		)
			throw new Error("请为每个问题选择有效选项。");
		return {
			question,
			selected: Array.from(values, (value) => {
				if (!Number.isSafeInteger(value) || value < 0 || value >= options.length) throw new Error("提问包含无效选项。");
				return options[value];
			}),
		};
	});
	return { status: "answered", answers };
}

/** 创建可在真实 pi 工具循环中等待用户选择的提问工具。
 * @param {Function} ask 向桌面宿主请求选项索引，取消时返回 undefined
 * @returns {object} pi 工具声明和执行器
 */
export function createQuestionTool(ask) {
	return {
		name: "ask_user_question",
		label: "向用户提问",
		description:
			"任务确实需要用户作决定时，在当前 Flower 对话请求选择。每题给可直接理解的简洁选项，用户可跳过。不要索取密码或密钥；选择不构成工作区写入审批。",
		executionMode: "sequential",
		parameters: {
			type: "object",
			required: ["questions"],
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					maxItems: questionLimit,
					items: {
						type: "object",
						required: ["question", "options"],
						properties: {
							question: { type: "string", minLength: 1, maxLength: questionLength },
							options: {
								type: "array",
								minItems: 2,
								maxItems: optionLimit,
								items: { type: "string", minLength: 1, maxLength: optionLength },
							},
							multiple: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
			},
			additionalProperties: false,
		},
		async execute(_id, args, signal) {
			signal?.throwIfAborted();
			const questions = checkedQuestions(args?.questions);
			const selection = await ask(questions, signal);
			signal?.throwIfAborted();
			if (selection === undefined) throw new Error("提问已结束，未收到用户选择。");
			const result = questionResult(questions, selection);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}

/** 主进程的临时提问登记处，仅向当前会话发布题目，并在裁定时重新校验运行归属。
 * @param {object} options 当前会话、运行及状态变更回调
 * @returns {object} 收取、读取、回答和清理本次运行的提问
 */
export function createQuestionBroker({ selected, isCurrent, changed, notify }) {
	const entries = new Map();
	return {
		request({ id, session, requestId, runId, questions }, signal) {
			if (
				signal.aborted ||
				![id, session, requestId, runId].every((value) => typeof value === "string" && idPattern.test(value)) ||
				entries.has(id) ||
				!isCurrent({ session, requestId, runId }) ||
				Array.from(entries.values()).some(({ prompt }) => prompt.session === session)
			)
				return;
			const prompt = { id, session, requestId, runId, questions: checkedQuestions(questions) };
			return new Promise((resolve) => {
				const finish = (selection) => {
					if (!entries.delete(id)) return;
					signal.removeEventListener("abort", abort);
					resolve(selection);
					changed();
				};
				const abort = () => finish();
				entries.set(id, { prompt, finish });
				signal.addEventListener("abort", abort, { once: true });
				changed();
				notify(session);
			});
		},
		current() {
			return Array.from(entries.values()).find(({ prompt }) => prompt.session === selected())?.prompt;
		},
		sessions() {
			return new Set(Array.from(entries.values(), ({ prompt }) => prompt.session));
		},
		answer(id, selection) {
			const entry = entries.get(id);
			if (!entry || entry.prompt.session !== selected()) return false;
			if (!isCurrent(entry.prompt)) {
				entry.finish();
				return false;
			}
			questionResult(entry.prompt.questions, selection);
			entry.finish(selection);
			return true;
		},
		dismiss(matches = () => true) {
			for (const { prompt, finish } of entries.values()) if (matches(prompt)) finish();
		},
	};
}
