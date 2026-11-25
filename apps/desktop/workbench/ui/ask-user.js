/** 绑定当前会话的结构化提问卡。
 * @param {HTMLElement} root 提问卡容器
 * @param {object} handlers 提交、取消与焦点恢复
 * @returns {(prompt: object | undefined) => void} 更新当前待答问题
 */
window.flowerQuestion = (root, handlers) => {
	const { element, softScroll } = window.flowerUI;
	const form = root.querySelector("form");
	const body = root.querySelector(".ask-user-body");
	const send = root.querySelector("#answer-question");
	const skip = root.querySelector("#skip-question");
	const stop = root.querySelector("#stop-question");
	const error = root.querySelector("#ask-user-error");
	const live = document.getElementById("ask-user-live");
	let current;
	let fieldsets = [];
	let sending;
	softScroll(body);

	function selections() {
		return fieldsets.map((field) => Array.from(field.querySelectorAll("input:checked"), (input) => Number(input.value)));
	}

	function sync() {
		const busy = Boolean(sending && sending.id === current?.id);
		send.disabled = !current || busy || selections().some((group) => !group.length);
		skip.disabled = busy;
		stop.disabled = busy;
	}

	async function respond(selection) {
		const prompt = current;
		if (!prompt || sending?.id === prompt.id) return;
		const focus = root.contains(document.activeElement) ? document.activeElement : undefined;
		const attempt = { id: prompt.id, focus };
		sending = attempt;
		error.textContent = "";
		sync();
		try {
			const accepted = await handlers.answer(prompt.id, selection);
			if (!accepted && current?.id === prompt.id) error.textContent = "这道问题已结束。";
		} catch {
			if (current?.id === prompt.id) error.textContent = "回答未发送，请重试。";
		} finally {
			if (sending === attempt) sending = undefined;
			sync();
			if (current?.id === prompt.id && document.activeElement === document.body) focus?.focus({ preventScroll: true });
		}
	}

	form.addEventListener("change", sync);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!send.disabled) void respond(selections());
	});
	skip.addEventListener("click", () => void respond(null));
	stop.addEventListener("click", () => {
		if (current && !stop.disabled) handlers.cancel(current);
	});

	return (prompt) => {
		if (prompt?.id === current?.id) return;
		// 等待期间禁用点击按钮会让 Chromium 失去焦点。只有焦点仍在卡片或落到正文时才恢复。
		const wasFocused =
			root.contains(document.activeElement) ||
			(sending?.id === current?.id && sending?.focus && document.activeElement === document.body);
		current = prompt;
		error.textContent = "";
		root.hidden = !prompt;
		live.textContent = prompt ? `当前会话有 ${prompt.questions.length} 个问题待回答。` : "";
		body.scrollTop = 0;
		fieldsets = (prompt?.questions ?? []).map(({ question, options, multiple }, index) => {
			const fieldset = element("fieldset", "ask-user-question");
			const legend = element("legend", "", question);
			if (multiple) legend.append(element("span", "ask-user-multiple", "可多选"));
			const choices = element("div", "ask-user-options");
			for (const [option, label] of options.entries()) {
				const row = element("label", "ask-user-option");
				const input = element("input");
				input.type = multiple ? "checkbox" : "radio";
				input.name = `ask-user-${index}`;
				input.value = String(option);
				row.append(input, element("span", "", label));
				choices.append(row);
			}
			fieldset.append(legend, choices);
			return fieldset;
		});
		body.replaceChildren(...fieldsets);
		sync();
		if (wasFocused) {
			if (prompt) fieldsets[0]?.querySelector("input").focus({ preventScroll: true });
			else handlers.restoreFocus();
		}
	};
};
