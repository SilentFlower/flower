(() => {
	const activeStatuses = new Set(["queued", "running", "cancelling"]);

	/**
	 * 右栏的侧边追问：以打开时主会话已完成的上下文为参考另开一段只读对话，主会话继续运行、互不影响。
	 * 每个主会话最多一个侧边追问，只收文字，回答期间不接收新消息；还没有时，在页内发送第一条即新建。
	 * @param {object} host 桌面接口
	 * @param {object} options 工作台能力
	 * @param {{showSide(trigger?: HTMLElement): void, sideAvailable(available: boolean): void}} options.panel 右栏面板，有当前主会话时才显示侧边追问页
	 * @param {(text: string, options?: object) => void} options.toast 显示提示
	 * @param {(title: string, detail: string, apply: string) => Promise<boolean>} options.confirm 打开确认框
	 * @param {(record: object, event: object) => void} options.apply 按运行事件更新请求记录
	 * @param {(error: unknown, fallback: string) => string} options.errorText 取出宿主给出的错误说明
	 * @returns {object} 侧边追问接口
	 */
	function createSideChat(host, { panel, toast, confirm, apply, errorText }) {
		const by = (id) => document.getElementById(id);
		const prompt = by("side-chat-prompt");
		const send = by("side-chat-send");
		const scroll = by("side-chat-scroll");
		window.flowerUI.softScroll(scroll);
		let parent = "";
		let runtimeRevision;
		let chats = [];
		let chat;
		let requests = new Map();
		let reading;
		let submitting = false;
		// 历史读取期间收到的事件以本地记录为准，避免迟到的历史覆盖更新的正文。
		let touched = 0;
		let frame = 0;

		const busy = () => [...requests.values()].some(({ status }) => activeStatuses.has(status));
		async function run(action, fallback) {
			try {
				return await action();
			} catch (error) {
				toast(errorText(error, fallback), { tone: "error" });
			}
		}
		async function copy(text, done) {
			if (text && (await run(() => host.copyText(text).then(() => true), "无法复制这段内容。"))) toast(done);
		}
		const thread = window.agentUI.thread(
			by("side-chat-timeline"),
			scroll,
			{
				cancel: (id, runId) => void run(() => host.cancelSideChat(parent, id, runId), "无法停止侧边追问。"),
				copy: (id) => void copy(requests.get(id)?.text, "已复制回复原文。"),
				copyInput: (id) => void copy(requests.get(id)?.input, "已复制提问原文。"),
				retry: (id) => void submit(requests.get(id)?.input),
				edit(id) {
					const input = requests.get(id)?.input;
					if (!input) return;
					prompt.value = input;
					sync();
					prompt.focus();
				},
				openLink: (url) => void run(() => host.openReplyLink(url), "此回复链接无法打开。"),
				open() {},
				preview() {},
				previewAttachment() {},
			},
			by("side-chat-bottom"),
		);
		window.agentUI.bindComposer(prompt, send);

		function sync() {
			send.disabled = !parent || submitting || busy() || !prompt.value.trim();
			send.title = busy() ? "侧边追问正在回答" : "发送侧边追问";
			send.setAttribute("aria-label", send.title);
		}
		function render(follow = false) {
			if (frame) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			by("side-chat-empty").hidden = requests.size > 0;
			thread.update(requests.values(), follow);
			sync();
		}
		function showHead() {
			by("side-chat-reference").textContent = chat
				? `基于主会话已完成的 ${chat.turns} 轮对话`
				: "发送第一条后，以主会话已完成的对话为参考开始";
			// 新建与关闭只对已有的侧边追问有意义。
			by("side-chat-new").hidden = by("side-chat-close").hidden = !chat;
		}
		function reset(next) {
			chat = next;
			reading = undefined;
			requests = new Map();
			thread.reset();
			showHead();
			panel.sideAvailable(Boolean(parent));
			render();
		}
		async function reload() {
			if (!chat) return;
			const stamp = Symbol();
			const owner = chat.id;
			const before = touched;
			reading = stamp;
			try {
				const rows = await host.sideChatHistory(parent);
				if (reading !== stamp || chat?.id !== owner) return;
				const merged = new Map();
				for (const row of rows) {
					const current = requests.get(row.requestId);
					merged.set(row.requestId, current?.touched > before ? { ...row, ...current, input: row.input } : row);
				}
				for (const [id, current] of requests) if (!merged.has(id)) merged.set(id, current);
				requests = merged;
				render();
			} catch (error) {
				if (reading === stamp) toast(errorText(error, "暂时无法读取侧边追问。"), { tone: "error" });
			} finally {
				if (reading === stamp) reading = undefined;
			}
		}
		function insert(record) {
			const current = requests.get(record.requestId);
			requests.set(record.requestId, { ...record, ...current, input: record.input, steps: current?.steps ?? [] });
			render(true);
		}
		async function submit(text = prompt.value) {
			if (!parent || !text?.trim() || submitting || busy()) return;
			submitting = true;
			const typed = text === prompt.value;
			if (typed) prompt.value = "";
			sync();
			try {
				// 还没有侧边追问时，第一条消息先以当前主会话新建一个；失败时原文放回输入框。
				if (!chat && !(await create())) {
					if (typed && !prompt.value) prompt.value = text;
					return;
				}
				insert(await host.submitSideChat(parent, text));
			} catch (error) {
				if (typed && !prompt.value) prompt.value = text;
				toast(errorText(error, "侧边追问未能发送。"), { tone: "error" });
			} finally {
				submitting = false;
				sync();
			}
		}
		/** 打开主会话的新侧边追问，替换已有的一个。@returns {Promise<boolean>} 是否成功 */
		async function create() {
			const created = await run(() => host.openSideChat(parent), "无法打开侧边追问。");
			if (!created) return false;
			chats = [...chats.filter((entry) => entry.parent !== created.parent), { ...created, busy: false }];
			reset(created);
			return true;
		}
		function quote(text) {
			const result = window.agentUI.quoteInsertion(
				prompt.value,
				prompt.selectionStart,
				prompt.selectionEnd,
				text,
				prompt.maxLength,
			);
			if (!result) return toast("引用后超过 16000 字，未插入。", { tone: "error" });
			prompt.value = result.value;
			prompt.setSelectionRange(result.caret, result.caret);
			sync();
		}

		prompt.addEventListener("input", sync);
		send.addEventListener("click", () => void submit());
		by("side-chat-new").addEventListener("click", async () => {
			if (!(await confirm("新建侧边追问？", "当前侧边追问的记录将被删除，主会话不受影响。", "新建")) || !(await create()))
				return;
			prompt.focus();
		});
		by("side-chat-close").addEventListener("click", async () => {
			if (!chat || !(await confirm("关闭侧边追问？", "将停止并删除本次追问，主会话不受影响。", "关闭并删除"))) return;
			if ((await run(() => host.closeSideChat(parent).then(() => true), "无法关闭侧边追问。")) !== true) return;
			chats = chats.filter((entry) => entry.parent !== parent);
			prompt.value = "";
			reset(undefined);
		});

		return {
			/**
			 * 跟随当前主会话与 Main 登记的侧边追问。
			 * @param {string} selected 当前主会话 ID
			 * @param {{id: string, parent: string, turns: number}[]} list 全部侧边追问
			 * @param {number} [revision] 工作进程编号；变化表示进程已退出，运行中的追问不会再有终态事件
			 * @returns {void}
			 */
			setState(selected, list = [], revision) {
				chats = list;
				const next = chats.find((entry) => entry.parent === selected);
				const restarted = runtimeRevision !== undefined && revision !== runtimeRevision;
				runtimeRevision = revision;
				if (selected === parent && next?.id === chat?.id) {
					if (next) chat = next;
					showHead();
					// 重读历史，未完成的追问显示为已中断并恢复可发送。
					if (restarted) void reload();
					return;
				}
				if (selected !== parent) prompt.value = "";
				parent = selected ?? "";
				reset(next);
				void reload();
			},
			/**
			 * 处理侧边追问的运行事件。
			 * @param {object} event 运行时事件
			 * @returns {boolean} 事件属于某个侧边追问时为 true，主会话不再处理
			 */
			receive(event) {
				if (!chats.some(({ id }) => id === event.sessionId)) return false;
				if (event.sessionId !== chat?.id) return true;
				const record = requests.get(event.requestId) ?? {
					input: "",
					requestId: event.requestId,
					text: "",
					status: "queued",
					steps: [],
				};
				requests.set(event.requestId, record);
				record.touched = ++touched;
				apply(record, event);
				if (event.type === "terminal") void reload();
				// 同一绘制帧内的正文分片共用一次排版。
				if (event.type !== "text_delta") render();
				else if (!frame) frame = requestAnimationFrame(() => render());
				return true;
			},
			/**
			 * 打开侧边追问页，没有时先新建；带文字时以引用块放入侧边输入框。
			 * @param {string} [text] 选中的回复文字
			 * @param {HTMLElement} [trigger] 收起右栏时返回焦点的按钮
			 * @returns {Promise<void>}
			 */
			async open(text, trigger) {
				if (!parent || (!chat && !(await create()))) return;
				panel.showSide(trigger);
				if (text) quote(text);
				prompt.focus();
			},
			/**
			 * 把排队消息转为侧边追问发送；附件不随行。
			 * @param {string} item 排队消息 ID
			 * @param {HTMLElement} [trigger] 收起右栏时返回焦点的按钮
			 * @returns {Promise<void>}
			 */
			async fromQueue(item, trigger) {
				if (!parent || (!chat && !(await create()))) return;
				if (busy()) return toast("侧边追问正在回答，请稍候或先停止。", { tone: "error" });
				panel.showSide(trigger);
				const result = await run(() => host.queueToSideChat(parent, item), "无法转为侧边追问。");
				if (!result) return;
				insert(result.record);
				if (result.dropped) toast(`侧边追问只收文字，${result.dropped} 个附件没有带入。`);
			},
		};
	}
	window.createSideChat = createSideChat;
})();
