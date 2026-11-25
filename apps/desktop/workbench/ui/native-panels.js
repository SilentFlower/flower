(() => {
	const terminalInputLimit = 16384;
	const openOutputLimit = 256 * 1024;

	/** 建立终端和网页面板，保持原工作台布局与主进程边界。
	 * @param {object} host 受限桌面接口
	 * @returns {object} 显示、收起、事件入口
	 */
	function createNativePanels(host) {
		const { element, button, icon, feedback } = window.flowerUI;
		const surface = document.getElementById("native-panel-view");
		const terminalView = element("section", "native-panel-body");
		terminalView.setAttribute("aria-label", "终端");
		const terminalToolbar = element("div", "native-panel-toolbar");
		const terminalPath = element("span", "native-terminal-path");
		const terminalStart = button("打开终端", () => void startTerminal(true), "secondary");
		terminalStart.id = "native-terminal-start";
		const terminalInterrupt = button("中断", () => sendInput("\x03"), "quiet");
		terminalInterrupt.id = "native-terminal-interrupt";
		terminalInterrupt.title = "中断当前命令 (Ctrl+C)";
		terminalInterrupt.disabled = true;
		terminalToolbar.append(terminalPath, terminalStart, terminalInterrupt);
		const terminalCanvas = element("div", "native-terminal-canvas");
		terminalCanvas.id = "native-terminal";
		const terminalHint = element("p", "native-panel-status");
		terminalHint.setAttribute("role", "status");
		terminalHint.id = "native-terminal-status";
		terminalView.append(terminalToolbar, terminalCanvas, terminalHint);

		const browserView = element("section", "native-panel-body");
		browserView.setAttribute("aria-label", "浏览器");
		const browserToolbar = element("form", "native-panel-toolbar native-browser-toolbar");
		const browserAddress = element("input", "native-browser-address");
		browserAddress.type = "text";
		browserAddress.id = "native-browser-address";
		browserAddress.placeholder = "输入网页地址";
		browserAddress.setAttribute("aria-label", "网页地址");
		browserAddress.autocomplete = "off";
		browserAddress.spellcheck = false;
		browserAddress.maxLength = 4096;
		const navigationControl = (id, label, symbol, action) => {
			const control = button("", () => void navigateAction(action), "icon-button");
			control.id = id;
			control.title = label;
			control.setAttribute("aria-label", label);
			control.append(icon(symbol));
			control.disabled = true;
			return control;
		};
		const back = navigationControl("native-browser-back", "后退", "back", "back");
		const forward = navigationControl("native-browser-forward", "前进", "forward", "forward");
		const reload = navigationControl("native-browser-reload", "刷新网页", "reset", "reload");
		const go = element("button", "button secondary", "打开");
		go.type = "submit";
		go.id = "native-browser-go";
		browserToolbar.append(back, forward, reload, browserAddress, go);
		const browserStatus = element("p", "native-panel-status");
		browserStatus.id = "native-browser-status";
		browserStatus.setAttribute("role", "status");
		const viewport = element("div", "native-browser-viewport");
		viewport.id = "native-browser-viewport";
		viewport.append(element("p", "native-browser-empty", "输入网址后在这里查看网页。"));
		browserView.append(browserToolbar, browserStatus, viewport);
		surface.append(terminalView, browserView);

		let mode;
		let session;
		let terminal;
		let opening;
		let terminalId;
		let terminalSize;
		let terminalInputTail = Promise.resolve();
		let browserOwner;
		let browserState;
		let addressEdited = false;
		let previousBounds;
		let frame;

		const textError = (error) =>
			error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") || "无法完成这项操作。";

		function terminalPalette() {
			const css = getComputedStyle(surface);
			const sample = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
			return {
				background: sample("--surface", "#fff"),
				foreground: sample("--ink", "#242420"),
				cursor: sample("--ink", "#242420"),
				selectionBackground: sample("--wash", "#b7aed8"),
			};
		}

		function resizeTerminal({ cols, rows }) {
			const next = `${cols}:${rows}`;
			if (cols < 2 || cols > 300 || rows < 1 || rows > 200 || !terminalId || next === terminalSize) return;
			terminalSize = next;
			void host.terminalResize(session.id, terminalId, cols, rows).catch(() => {});
		}

		function sendInput(data) {
			if (mode !== "terminal" || !session?.id || !terminalId) return;
			const id = terminalId;
			const owner = session.id;
			terminalInputTail = terminalInputTail
				.then(async () => {
					// 粘贴大段内容时拆成有界块，保持单次输入内的字符和顺序。
					for (let offset = 0; offset < data.length && terminalId === id; ) {
						let end = Math.min(data.length, offset + terminalInputLimit);
						const last = data.charCodeAt(end - 1);
						if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
						await host.terminalInput(owner, id, data.slice(offset, end));
						offset = end;
					}
				})
				.catch((error) => {
					if (terminalId === id) feedback(terminalHint, textError(error), "error");
				});
		}

		function stopTerminal() {
			if (terminalId || opening) {
				void host.terminalClose(session?.id, terminalId).catch(() => {});
			}
			terminalId = undefined;
			terminalSize = undefined;
			terminalInputTail = Promise.resolve();
			clearTimeout(opening?.timer);
			opening = undefined;
			terminal?.close();
			terminal = undefined;
			terminalCanvas.replaceChildren();
			terminalInterrupt.disabled = true;
			terminalStart.disabled = !session?.id;
		}

		function processTerminal(event) {
			if (event.type === "output") terminal?.postMessage({ type: "write", data: event.data });
			if (event.type === "exit") {
				terminalId = undefined;
				terminalInterrupt.disabled = true;
				terminalStart.disabled = false;
				terminalStart.textContent = "重新打开";
				feedback(terminalHint, `终端已退出（状态 ${event.exitCode}）。`);
			}
		}

		function failTerminal(attempt, description) {
			if (opening !== attempt) return;
			clearTimeout(attempt.timer);
			opening = undefined;
			terminalStart.disabled = false;
			feedback(terminalHint, description, "error");
		}

		async function connectTerminal(owner, attempt, size) {
			clearTimeout(attempt.timer);
			try {
				const { cols, rows } = size;
				const { id } = await host.terminalOpen(owner, cols, rows);
				if (opening !== attempt) {
					void host.terminalClose(owner, id).catch(() => {});
					return;
				}
				terminalId = id;
				terminalSize = `${cols}:${rows}`;
				terminalStart.textContent = "终端已打开";
				terminalInterrupt.disabled = false;
				feedback(terminalHint, "以当前系统用户运行，Ctrl+C 可中断命令。");
				for (const pending of attempt.output) {
					if (pending.id === terminalId) processTerminal(pending);
				}
				if (attempt.size) resizeTerminal(attempt.size);
			} catch (error) {
				failTerminal(attempt, textError(error));
			} finally {
				if (opening === attempt) opening = undefined;
			}
		}

		function startTerminal(focus = false) {
			if (!session?.id || opening || terminalId || mode !== "terminal") return;
			if (typeof host.terminalOpen !== "function") {
				feedback(terminalHint, "终端组件暂不可用。", "error");
				return;
			}
			terminal?.close();
			const owner = session.id;
			const channel = new MessageChannel();
			const frame = element("iframe", "native-terminal-frame");
			frame.id = "native-terminal-frame";
			frame.title = "终端命令输入";
			// Chromium 的 file:// 页面必须使用其原有来源才能读取同一 ASAR 内的脚本和样式。
			frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
			// 只把私有端口交给固定本地页面。浏览器视图和终端输出均无法得到此端口。
			frame.src = "./ui/native-terminal.html";
			frame.addEventListener(
				"load",
				() => {
					if (terminal !== channel.port1) return;
					frame.contentWindow.postMessage({ type: "flower-terminal", theme: terminalPalette(), focus }, "*", [
						channel.port2,
					]);
				},
				{ once: true },
			);
			const attempt = { output: [], length: 0 };
			attempt.timer = setTimeout(() => failTerminal(attempt, "终端组件加载失败，可以重试。"), 8000);
			opening = attempt;
			terminal = channel.port1;
			terminal.onmessage = ({ data }) => {
				if (terminal !== channel.port1) return;
				if (data.type === "ready" && opening === attempt) void connectTerminal(owner, attempt, data);
				if (data.type === "input") sendInput(data.data);
				if (data.type === "size") {
					if (opening === attempt) attempt.size = data;
					else resizeTerminal(data);
				}
				if (data.type === "error") failTerminal(attempt, "终端组件暂不可用。");
			};
			terminalCanvas.replaceChildren(frame);
			terminalStart.disabled = true;
			feedback(terminalHint, "正在打开终端…");
		}

		function showBrowserState(next) {
			browserState = next;
			if (next?.url && !addressEdited) browserAddress.value = next.url;
			back.disabled = !next?.canGoBack;
			forward.disabled = !next?.canGoForward;
			reload.disabled = !next?.url;
			viewport.dataset.page = String(Boolean(next?.url));
			feedback(browserStatus, next?.error || (next?.loading ? "正在加载网页…" : ""), next?.error ? "error" : "neutral");
		}

		async function navigateAction(action) {
			if (mode !== "browser") return;
			addressEdited = false;
			try {
				await host.browserAction(browserOwner, action);
			} catch (error) {
				if (mode === "browser") feedback(browserStatus, textError(error), "error");
			}
		}
		browserAddress.addEventListener("input", () => {
			addressEdited = true;
		});
		browserToolbar.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (mode !== "browser" || !browserAddress.value.trim()) return;
			const owner = browserOwner;
			addressEdited = false;
			feedback(browserStatus, "正在加载网页…");
			try {
				await host.browserNavigate(owner, browserAddress.value);
			} catch (error) {
				if (mode === "browser" && owner === browserOwner) feedback(browserStatus, textError(error), "error");
			}
		});

		function visibility() {
			// 原生 WebContents 位于 DOM 之上。弹层、收起和拖动期间先移开，避免遮住按钮或抢接输入。
			const uncovered =
				mode === "browser" &&
				!document.hidden &&
				!document.querySelector("dialog[open], :popover-open") &&
				!surface.closest("[hidden]") &&
				!document.getElementById("workbench")?.matches("[data-panel-dragging], [data-management]");
			const rect = uncovered ? viewport.getBoundingClientRect() : null;
			const next =
				rect?.width > 2 && rect.height > 2 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
			const key = JSON.stringify(next);
			if (browserOwner === undefined || previousBounds === key || typeof host.browserBounds !== "function") return;
			previousBounds = key;
			void host.browserBounds(browserOwner, next).catch(() => {});
		}

		function refreshLayout() {
			if (mode === "browser") {
				cancelAnimationFrame(frame);
				frame = requestAnimationFrame(visibility);
			}
		}
		const layout = new ResizeObserver(refreshLayout);
		layout.observe(viewport);
		addEventListener("resize", refreshLayout);
		document.addEventListener("scroll", refreshLayout, true);
		document.addEventListener("toggle", visibility, true);
		document.addEventListener("visibilitychange", visibility);
		const workbench = document.getElementById("workbench");
		const chrome = new MutationObserver(() => {
			if (mode === "browser") visibility();
		});
		if (workbench)
			chrome.observe(workbench, {
				attributes: true,
				attributeFilter: ["data-panel-dragging", "data-panel-side", "data-panel", "data-panel-size"],
			});
		new MutationObserver(() => {
			terminal?.postMessage({ type: "theme", theme: terminalPalette() });
		}).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

		function hide() {
			if (!mode) return;
			if (mode === "terminal") stopTerminal();
			mode = undefined;
			session = undefined;
			surface.hidden = true;
			visibility();
		}

		return {
			/** 显示指定工具并绑定当前选择。@param {string} next 工具名 @param {object} selected 当前会话 @returns {void} */
			show(next, selected) {
				if (mode === next && session?.id === selected?.id) {
					session = selected;
					refreshLayout();
					return;
				}
				hide();
				mode = next;
				session = selected;
				surface.hidden = false;
				terminalView.hidden = mode !== "terminal";
				browserView.hidden = mode !== "browser";
				if (mode === "terminal") {
					terminalPath.textContent = selected?.workspace || "终端";
					terminalPath.title = selected?.path || "";
					terminalStart.textContent = "打开终端";
					terminalStart.disabled = !selected?.id;
					feedback(terminalHint, selected?.id ? "终端从当前工作区启动。" : "先选择一个工作区。");
					if (selected?.id) void startTerminal();
				}
				if (mode === "browser") {
					const owner = selected?.id ?? "";
					if (owner !== browserOwner) {
						browserOwner = owner;
						browserAddress.value = "";
						addressEdited = false;
						previousBounds = undefined;
						showBrowserState(undefined);
					} else showBrowserState(browserState);
					refreshLayout();
				}
			},
			hide,
			refreshVisibility: visibility,
			/** 接收当前面板的事件。@param {object} event Host 事件 @returns {void} */
			receive(event) {
				if (event.panel === "browser" && event.session === browserOwner) showBrowserState(event);
				if (event.panel !== "terminal" || mode !== "terminal" || event.session !== session?.id) return;
				if (event.id === terminalId) processTerminal(event);
				else if (opening && opening.length < openOutputLimit) {
					opening.output.push(event);
					opening.length += event.data?.length ?? 1;
				}
			},
		};
	}
	window.createNativePanels = createNativePanels;
})();
