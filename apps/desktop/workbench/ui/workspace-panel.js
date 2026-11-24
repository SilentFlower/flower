(() => {
	/** 创建当前会话的只读工作区面板。
	 * @param {object} host 工作台的受限桌面接口
	 * @returns {object} 用于绑定会话和从消息中预览交付物的面板接口
	 */
	function createWorkspacePanel(host) {
		const { element, icon, button } = window.flowerUI;
		const by = (id) => document.getElementById(id);
		const workbench = by("workbench");
		const conversation = document.querySelector(".conversation");
		const panel = by("workspace-panel");
		const header = panel.querySelector(".workspace-panel-header");
		const toggle = by("workspace-panel-toggle");
		const dock = by("workspace-panel-dock");
		const expand = by("workspace-panel-expand");
		const back = by("panel-up");
		const refresh = by("panel-refresh");
		const content = by("panel-content");
		const location = by("panel-location");
		const view = by("workspace-panel-view");
		window.flowerUI.softScroll(view);
		const narrow = matchMedia("(max-width: 980px)");
		const previewAdd = by("panel-reference");
		let attached = new Set();
		let selected;
		let ready = false;
		let folders = [];
		let file = "";
		let attachment;
		// 回复中的文件名对应多个同名文件时的候选：{ name, paths }。
		let choices;
		let mode = "files";
		let change;
		const collator = new Intl.Collator(undefined, { numeric: true });
		let revision = 0;
		let disposePreview;
		let opener = toggle;
		let pageOffset = 0;
		const entries = new Map();
		let side = "right";
		// requested 表示已请求 Main 为并排面板扩展窗口，granted 是实际扩出的页面宽度。
		let requested = false;
		let granted = 0;
		let fitting = Promise.resolve();
		let fitStamp = 0;
		let preferredWidth = 0;
		let drag;

		function status(text = "", error = false) {
			const line = by("panel-status");
			line.textContent = text;
			line.hidden = !text;
			line.dataset.error = String(error);
		}

		function message(error) {
			return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") || "无法读取工作区。";
		}

		function renderTables(sheets) {
			for (const sheet of sheets) {
				const wrapper = element("div", "panel-sheet");
				wrapper.tabIndex = 0;
				const table = element("table");
				if (sheet.name) table.append(element("caption", "", sheet.name));
				const body = table.createTBody();
				for (const [index, values] of sheet.rows.entries()) {
					const row = body.insertRow();
					for (const value of values) row.append(element(index === 0 ? "th" : "td", "", String(value)));
				}
				wrapper.append(table);
				content.append(wrapper);
			}
		}

		function renderPreview(result, stamp) {
			if (result.kind === "workbook") {
				renderTables(result.sheets);
				return status(result.sheets.length ? "显示工作表样本。" : "工作簿中没有可预览的工作表。");
			}
			if (result.kind === "table") {
				if (!result.rows.length)
					return status(result.truncated ? "前 64 KiB 中没有完整的记录可预览。" : "这个文件是空的。");
				renderTables([result]);
				if (result.truncated) status("仅显示部分行列或单元格内容。");
				return;
			}
			if (result.kind === "document") {
				if (!result.paragraphs.length) return status("文档中没有可预览的正文。");
				const article = element("article", "panel-document");
				for (const paragraph of result.paragraphs) article.append(element("p", "", paragraph));
				content.append(article);
				if (result.truncated) status("仅显示部分正文。");
				return;
			}
			if (result.kind === "image") {
				const image = element("img", "panel-image");
				image.alt = mode === "git" ? change.path : file;
				image.decoding = "async";
				const blob = new Blob([result.bytes], { type: result.mime });
				const url = URL.createObjectURL(blob);
				const name = image.alt;
				const open = button(
					"",
					(event) => void window.flowerImages.open(name, () => blob, event.currentTarget),
					"panel-zoom-image",
				);
				open.setAttribute("aria-label", `查看大图：${name}`);
				open.title = "查看大图";
				open.append(image);
				disposePreview = () => URL.revokeObjectURL(url);
				image.addEventListener("error", () => {
					if (revision === stamp) {
						open.remove();
						status("图片未能打开，请检查文件。", true);
					}
				});
				image.src = url;
				content.append(open);
				return;
			}
			if (result.kind === "pdf") {
				disposePreview = window.previewWorkspacePDF(content, result.bytes, (text, error) => {
					if (revision === stamp) status(text, error);
				});
				return;
			}
			if (result.kind === "unsupported") return status("此格式暂不支持预览。");
			if (!result.text) return status("这个文件是空的。");
			if (result.kind === "markdown") {
				const article = element("article", "markdown-reply");
				window.flowerMarkdown
					.view(article, (url) =>
						host.openReplyLink(url).catch((error) => {
							if (revision === stamp) status(message(error), true);
						}),
					)
					.update(result.text);
				content.append(article);
			} else {
				content.append(
					element(
						"pre",
						/\.txt$/i.test(mode === "git" ? change?.path : file) ? "panel-text panel-prose" : "panel-text",
						result.text,
					),
				);
			}
			if (result.truncated) status("仅预览文件开头的 64 KiB。");
		}

		function updateReference(control) {
			const path = control.dataset.path;
			const added = attached.has(`file:${path}`);
			control.setAttribute("aria-disabled", String(added));
			control.title = added ? `已加入对话：${path}` : `加入对话：${path}`;
			control.setAttribute("aria-label", control.title);
			if (control === previewAdd) control.textContent = added ? "已加入" : "加入对话";
			else control.querySelector("use").setAttribute("href", added ? "#icon-check" : "#icon-plus");
		}
		async function addReference(control) {
			const stamp = revision;
			if (control.getAttribute("aria-disabled") === "true" || !selected) return;
			try {
				await host.referenceFile(selected.id, control.dataset.path);
			} catch (error) {
				if (stamp === revision) status(message(error), true);
			}
		}
		previewAdd.addEventListener("click", () => void addReference(previewAdd));

		function fileKind(name, directory = false) {
			if (directory) return "folder";
			if (/\.(xlsx|csv|tsv)$/i.test(name)) return "table";
			if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return "image";
			if (/\.(?:md|mdx|pdf|docx|txt)$/i.test(name)) return "report";
			if (/\.(?:[cm]?[jt]sx?|json|css|html|py|sh|go|rs|java|ya?ml)$/i.test(name)) return "code";
			return "document";
		}

		function renderChoices() {
			status(`工作区中有 ${choices.paths.length} 个名为 ${choices.name} 的文件，选择要预览的一个。`);
			const list = element("ul", "panel-file-list");
			for (const path of choices.paths) {
				const parts = path.split("/");
				const name = parts.pop();
				const control = button(
					"",
					() => {
						folders = parts;
						file = name;
						view.focus({ preventScroll: true });
						void load();
					},
					"panel-file-row panel-choice",
				);
				const type = fileKind(name);
				control.dataset.kind = type;
				control.dataset.ext = (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();
				// 同名文件靠所在目录区分：主文字为直接上级目录，其余上级路径作补充。
				control.append(
					icon(type),
					element("span", "", parts.at(-1) ?? "工作区根目录"),
					element("small", "panel-choice-parent", parts.slice(0, -1).join("/")),
				);
				control.title = path;
				control.setAttribute("aria-label", `预览文件：${path}`);
				const row = element("li");
				row.append(control);
				list.append(row);
			}
			content.replaceChildren(list);
		}

		function renderDirectory(result, restoreName) {
			for (const entry of result.entries) entries.set(entry.name, entry);
			pageOffset += result.entries.length;
			const list = element("ul", "panel-file-list");
			let restore;
			const ordered = [...entries.values()].sort((a, b) =>
				a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "directory" ? -1 : 1,
			);
			for (const entry of ordered) {
				const directory = entry.kind === "directory";
				const control = button(
					"",
					() => {
						if (directory) folders.push(entry.name);
						else file = entry.name;
						view.focus({ preventScroll: true });
						void load();
					},
					"panel-file-row",
				);
				const name = element("span", "", entry.name);
				const type = fileKind(entry.name, directory);
				control.dataset.kind = type;
				// 同属文档类的 PDF 与 Word 按扩展名再区分图标颜色。
				control.dataset.ext = directory ? "" : (/\.([^.]+)$/.exec(entry.name)?.[1] ?? "").toLowerCase();
				control.append(icon(type), name);
				control.title = entry.name;
				control.setAttribute("aria-label", `${directory ? "进入目录" : "预览文件"}：${entry.name}`);
				if (directory) {
					const chevron = icon("chevron");
					chevron.classList.add("panel-enter");
					control.append(chevron);
				}
				const row = element("li");
				row.append(control);
				// 右键或菜单键在系统文件管理器中定位，或复制本机路径；单击本身已负责预览。
				const entryPath = [...folders, entry.name].join("/");
				control.addEventListener("contextmenu", (event) => {
					event.preventDefault();
					const owner = selected?.id;
					if (owner) void host.showPathMenu(owner, entryPath, false).catch(() => {});
				});
				if (entry.attachable) {
					// 可加入对话的文件行可以拖到输入框，效果与「+」相同。
					control.draggable = true;
					control.addEventListener("dragstart", (event) => {
						event.dataTransfer.setData("application/x-flower-path", entryPath);
						event.dataTransfer.effectAllowed = "copy";
					});
					const add = button("", (event) => void addReference(event.currentTarget), "icon-button panel-add");
					add.append(icon("plus"));
					add.dataset.path = [...folders, entry.name].join("/");
					updateReference(add);
					row.append(add);
				}
				list.append(row);
				if (entry.name === restoreName) restore = control;
			}
			content.replaceChildren(list);
			if (!entries.size) status("这个目录没有可显示的文件。");
			if (result.truncated && result.entries.length) {
				const more = button("显示更多", () => void load(undefined, true), "quiet panel-more");
				content.append(more);
			}
			if (document.activeElement === view) restore?.focus();
		}

		function setMode(next) {
			mode = next;
			by("panel-files").setAttribute("aria-pressed", String(mode === "files"));
			by("panel-git").setAttribute("aria-pressed", String(mode === "git"));
			by("panel-side").setAttribute("aria-pressed", String(mode === "side"));
			// 侧边追问有自己的消息区与输入框，文件浏览区随之隐藏。
			view.hidden = mode === "side";
			by("side-chat-view").hidden = mode !== "side";
		}
		for (const [id, next] of [
			["panel-files", "files"],
			["panel-git", "git"],
			["panel-side", "side"],
		])
			by(id).onclick = () => {
				setMode(next);
				void load();
			};

		function breadcrumbs() {
			location.replaceChildren();
			if (!selected) return;
			const parts =
				mode === "git"
					? [selected.workspace, change?.path].filter(Boolean)
					: attachment
						? ["对话附件", file]
						: choices && !file
							? [selected.workspace, `名为 ${choices.name} 的文件`]
							: [selected.workspace, ...folders, file].filter(Boolean);
			location.title = parts.join(" / ");
			for (const [index, part] of parts.entries()) {
				if (index) location.append(element("span", "crumb-separator", "›"));
				if (index === parts.length - 1 || attachment || mode === "git") location.append(element("span", "crumb", part));
				else
					location.append(
						button(
							part,
							() => {
								choices = undefined;
								folders = folders.slice(0, index);
								file = "";
								view.focus();
								void load();
							},
							"crumb-link",
						),
					);
			}
		}

		async function renderGit(stamp) {
			if (change) {
				const result = await host.gitDifference(selected.id, change.path, change.group);
				if (stamp !== revision) return;
				status();
				if (result.preview) return renderPreview(result.preview, stamp);
				if (!result.text) return status("文件状态已变化，当前没有可显示的文本差异。");
				const lines = result.text.replace(/\n$/, "").split("\n");
				const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
				if (firstHunk < 0) {
					if (lines.some((line) => line.startsWith("Binary files "))) return status("二进制文件已变化。");
					content.append(
						element(
							"pre",
							"panel-text",
							lines.filter((line) => !line.startsWith("diff --git ")).join("\n") || "文件状态已变化。",
						),
					);
					return;
				}
				const diff = element("div", "git-diff");
				window.flowerUI.softScroll(diff);
				const caption = element("div", "diff-caption", change.group === "staged" ? "已暂存的更改" : "工作区更改");
				content.append(caption, diff);
				let oldLine = 0;
				let newLine = 0;
				for (const line of lines.slice(firstHunk, firstHunk + 1800)) {
					const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
					if (hunk) {
						oldLine = Number(hunk[1]);
						newLine = Number(hunk[2]);
						diff.append(
							element("div", "diff-hunk", `第 ${newLine || oldLine} 行${hunk[3].trim() ? ` · ${hunk[3].trim()}` : ""}`),
						);
						continue;
					}
					const sign = line[0];
					if (!["+", "-", " "].includes(sign)) {
						diff.append(element("div", "diff-hunk", line));
						continue;
					}
					const row = element("div", sign === "+" ? "diff-added" : sign === "-" ? "diff-removed" : "diff-context");
					row.append(
						element("small", "diff-number", sign === "+" ? "" : String(oldLine++)),
						element("small", "diff-number", sign === "-" ? "" : String(newLine++)),
						element("span", "diff-sign", sign),
						element("code", "", line.slice(1)),
					);
					diff.append(row);
				}
				if (result.truncated || lines.length - firstHunk > 1800) status("差异较长，仅显示开头部分。");
				return;
			}
			const result = await host.gitChanges(selected.id);
			if (stamp !== revision) return;
			if (!result.repository) return status("当前工作区不在 Git 仓库中。");
			status();
			const branch = element("div", "git-branch");
			branch.append(icon("git"), element("strong", "", result.branch));
			content.append(branch);
			if (!result.total) return status("当前工作区没有变更。");
			for (const [group, title] of [
				["staged", "已暂存"],
				["working", "未暂存"],
			]) {
				const rows = result.entries.filter((entry) => entry.group === group);
				if (!rows.length) continue;
				const heading = element("h3", "git-group", title);
				heading.append(element("small", "", String(rows.length)));
				content.append(heading);
				for (const entry of rows) {
					const row = button(
						"",
						() => {
							change = entry;
							view.focus();
							void load();
						},
						"git-row",
					);
					row.title = entry.path;
					row.setAttribute("aria-label", `${title}：${entry.path}，${entry.label}`);
					const parts = entry.path.split("/");
					row.append(
						icon("document"),
						element("span", "git-name", parts.pop()),
						element("small", "git-parent", parts.join("/")),
						element("span", "git-state", entry.code),
					);
					row.dataset.code = entry.code;
					content.append(row);
				}
			}
			if (result.total > result.entries.length) status(`显示前 ${result.entries.length} 项，共 ${result.total} 项变更。`);
		}

		async function load(restoreName, more = false) {
			const stamp = ++revision;
			if (more) {
				view.focus({ preventScroll: true });
				content.querySelector(".panel-more").disabled = true;
			} else {
				disposePreview?.();
				disposePreview = undefined;
				pageOffset = 0;
				entries.clear();
				content.replaceChildren();
				view.scrollTop = 0;
			}
			if (panel.hidden) return;
			previewAdd.hidden = true;
			if (mode === "side") {
				status();
				by("panel-title").textContent = "侧边追问";
				return;
			}
			back.hidden = mode === "git" ? !change : !folders.length && !file && !choices;
			refresh.hidden = !selected;
			by("panel-title").textContent = mode === "git" ? "Git 变更" : file ? "文件预览" : "工作区文件";
			breadcrumbs();
			location.parentElement.hidden = !selected;
			if (!ready) return status("工作台正在加载…");
			if (!selected) {
				status("先选择一个工作区。");
				content.append(
					button(
						"选择工作区",
						async () => {
							try {
								await host.chooseWorkspace();
								if (!panel.hidden) view.focus({ preventScroll: true });
							} catch (error) {
								if (revision === stamp) status(message(error), true);
							}
						},
						"secondary",
					),
				);
				return;
			}
			status(mode === "git" ? "正在读取 Git 变更…" : file ? "正在读取文件…" : "正在读取目录…");
			try {
				if (mode === "git") return await renderGit(stamp);
				if (choices && !file && !attachment) return renderChoices();
				const path = [...folders, file].filter(Boolean).join("/") || ".";
				const result = attachment
					? await host.previewAttachment(selected.id, attachment.request, attachment.id)
					: file
						? await host.previewWorkspaceFile(selected.id, path)
						: await host.listWorkspaceEntries(selected.id, path, pageOffset);
				// 切换会话、目录或关闭面板后，丢弃上一处的异步结果。
				if (stamp !== revision) return;
				status();
				if (file) {
					previewAdd.hidden = Boolean(attachment) || !result.attachable;
					previewAdd.dataset.path = path;
					updateReference(previewAdd);
					renderPreview(result, stamp);
				} else renderDirectory(result, more ? result.entries[0]?.name : restoreName);
			} catch (error) {
				if (stamp === revision) {
					status(message(error), true);
					if (more) content.querySelector(".panel-more").disabled = false;
				}
			}
		}

		function overlay() {
			const drawer = !panel.hidden && narrow.matches;
			const covered = drawer || (!panel.hidden && panel.dataset.maximized === "true");
			by("workspace-panel-scrim").hidden = !drawer;
			conversation.inert = covered;
			document.querySelector(".sidebar").inert = drawer;
			if (covered && !panel.contains(document.activeElement)) by("workspace-panel-close").focus({ preventScroll: true });
		}

		function maximize(value) {
			panel.dataset.maximized = String(value);
			expand.title = value ? "还原面板大小" : "放大文件面板";
			expand.setAttribute("aria-label", expand.title);
			expand.setAttribute("aria-pressed", String(value));
			expand.querySelector("use").setAttribute("href", value ? "#icon-panel-restore" : "#icon-panel-expand");
			overlay();
		}

		function syncViewport() {
			if (workbench.dataset.windowFit) return;
			// 扩展期间按扣除面板扩展后的窗口宽度换算原先的 vw 尺寸，左栏、标题栏留白和输入区保持原几何。
			if (granted > 0) workbench.style.setProperty("--layout-vw", `${(innerWidth - granted) / 100}px`);
			else workbench.style.removeProperty("--layout-vw");
		}
		addEventListener("resize", syncViewport);

		function panelWidth() {
			// 扩展前固定栏宽：默认宽度按扩展前的视口计算，窗口变宽后不再随视口放大。
			const width = Math.max(minWidth, Math.min(920, preferredWidth || Math.round(innerWidth * 0.39)));
			workbench.style.setProperty("--panel-width", `${width}px`);
			return width;
		}

		/** 同步显示或收起面板，并让原生窗口为并排面板扩展或收回宽度。
		 * @param {Function} apply 修改面板显示状态
		 * @returns {void}
		 */
		function changeLayout(apply) {
			const chat = conversation.getBoundingClientRect().width;
			const viewport = workbench.dataset.windowFit ? undefined : innerWidth - granted;
			apply();
			// 并排打开时都为面板扩窗；左右换位共用已扩展的宽度，只交换面板与聊天区。
			const wanted = !panel.hidden && !narrow.matches;
			if (wanted === requested) return;
			requested = wanted;
			const stamp = ++fitStamp;
			// 布局变化前读取的宽度不含面板扩展，先冻结再改窗口，聊天区不会在过渡帧中伸缩。
			if (viewport !== undefined) workbench.style.setProperty("--layout-vw", `${viewport / 100}px`);
			workbench.style.setProperty("--chat-frozen", `${chat}px`);
			workbench.dataset.windowFit = "freeze";
			fitting = fitting
				.then(async () => {
					const start = innerWidth;
					const result = await host.setPanelExpansion(wanted ? panelWidth() : 0);
					granted = result.extra;
					// Main 同步设置外框，页面稍后才收到新宽度；隐藏窗口没有动画帧，用定时器兜底。
					const deadline = performance.now() + 1000;
					while (Math.abs(innerWidth - start - result.change) > 1 && performance.now() < deadline)
						await new Promise((resolve) => {
							requestAnimationFrame(resolve);
							setTimeout(resolve, 32);
						});
				})
				.catch(() => {})
				.then(() => {
					if (stamp !== fitStamp) return;
					delete workbench.dataset.windowFit;
					workbench.style.removeProperty("--chat-frozen");
					if (!requested && !preferredWidth) workbench.style.removeProperty("--panel-width");
					syncViewport();
				});
		}

		function display(open) {
			changeLayout(() => {
				panel.hidden = !open;
				if (!open && panel.dataset.maximized === "true") maximize(false);
				workbench.dataset.panel = open ? "open" : "closed";
			});
			toggle.setAttribute("aria-expanded", String(open));
			toggle.title = open ? "收起文件浏览器" : "打开文件浏览器";
			toggle.setAttribute("aria-label", toggle.title);
			overlay();
			void load();
			if (open) by("workspace-panel-close").focus({ preventScroll: true });
			else (opener?.isConnected ? opener : toggle).focus({ preventScroll: true });
		}

		toggle.addEventListener("click", () => {
			opener = toggle;
			display(panel.hidden);
		});
		expand.addEventListener("click", () => maximize(panel.dataset.maximized !== "true"));
		for (const id of ["workspace-panel-close", "workspace-panel-scrim"])
			by(id).addEventListener("click", () => display(false));
		refresh.addEventListener("click", () => void load());
		back.addEventListener("click", () => {
			if (mode === "git") {
				change = undefined;
				view.focus();
				void load();
				return;
			}
			attachment = undefined;
			if (choices) {
				// 从候选进入的预览返回候选列表，候选列表再返回到工作区根目录。
				if (file) folders = [];
				else choices = undefined;
				file = "";
				view.focus({ preventScroll: true });
				void load();
				return;
			}
			const previous = file || folders.pop();
			file = "";
			view.focus({ preventScroll: true });
			void load(previous);
		});
		narrow.addEventListener("change", overlay);
		const handle = by("workspace-panel-resize");
		const minWidth = 320;
		const maximumWidth = () =>
			Math.min(
				Math.floor(innerWidth * 0.62),
				920,
				Math.floor(innerWidth - by("sidebar-main").closest(".sidebar").getBoundingClientRect().width - 310),
			);
		function setWidth(width) {
			const bounded = Math.max(minWidth, Math.min(maximumWidth(), Math.round(width)));
			workbench.style.setProperty("--panel-width", `${bounded}px`);
		}
		new ResizeObserver(() => {
			if (panel.hidden || narrow.matches || panel.dataset.maximized === "true") return;
			handle.setAttribute("aria-valuemin", String(minWidth));
			handle.setAttribute("aria-valuemax", String(maximumWidth()));
			handle.setAttribute("aria-valuenow", String(Math.round(panel.getBoundingClientRect().width)));
		}).observe(panel);
		try {
			const saved = Number(localStorage.getItem("flower.workspace-panel.width"));
			if (saved >= minWidth && saved <= 920) {
				preferredWidth = saved;
				workbench.style.setProperty("--panel-width", `${saved}px`);
			}
		} catch {
			/* 偏好不可用时使用响应式默认宽度。 */
		}
		function rememberWidth() {
			preferredWidth = Math.round(panel.getBoundingClientRect().width);
			try {
				localStorage.setItem("flower.workspace-panel.width", String(preferredWidth));
			} catch {
				/* 保留当前窗口宽度。 */
			}
		}
		handle.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			handle.setPointerCapture(event.pointerId);
			handle.toggleAttribute("data-dragging", true);
		});
		handle.addEventListener("pointermove", (event) => {
			if (!handle.hasPointerCapture(event.pointerId)) return;
			setWidth(side === "right" ? innerWidth - event.clientX : event.clientX - panel.getBoundingClientRect().left);
		});
		handle.addEventListener("lostpointercapture", () => {
			handle.removeAttribute("data-dragging");
			rememberWidth();
		});
		handle.addEventListener("keydown", (event) => {
			const current = panel.getBoundingClientRect().width;
			// 方向键朝聊天区一侧时加宽面板，左右停靠各自对应相反的按键。
			const [wider, narrower] = side === "right" ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
			const width = { [wider]: current + 24, [narrower]: current - 24, Home: minWidth, End: maximumWidth() }[event.key];
			if (width === undefined) return;
			event.preventDefault();
			setWidth(width);
			rememberWidth();
		});

		try {
			if (localStorage.getItem("flower.workspace-panel.side") === "left") side = "left";
		} catch {
			/* 偏好不可用时停靠在聊天区右侧。 */
		}
		function applySide() {
			const edge = side === "right" ? "右" : "左";
			workbench.dataset.panelSide = side;
			dock.title = `移到聊天区${side === "right" ? "左" : "右"}侧`;
			dock.setAttribute("aria-label", dock.title);
			handle.setAttribute("aria-label", `调整${edge}侧栏宽度`);
			const close = by("workspace-panel-close");
			close.title = `收起${edge}侧栏`;
			for (const control of [close, by("workspace-panel-scrim")]) control.setAttribute("aria-label", close.title);
		}
		applySide();

		/** 将面板停靠到聊天区一侧，保留当前文件、预览和 Git 内容。@param {"left"|"right"} next 目标方向 @returns {void} */
		function placePanel(next) {
			side = next;
			applySide();
			try {
				localStorage.setItem("flower.workspace-panel.side", side);
			} catch {
				/* 仅保留当前窗口的停靠位置。 */
			}
			by("panel-layout-live").textContent = `文件面板已移到聊天区${side === "right" ? "右" : "左"}侧。`;
		}
		dock.addEventListener("click", () => placePanel(side === "right" ? "left" : "right"));

		// 标签、按钮、输入和调宽手柄保留原有操作，只有标题栏空白处可以拖动停靠。
		const dragExempt = "button, a[href], input, textarea, select, summary, [role='separator'], [contenteditable='true']";
		function showDrop(x, y) {
			drag.ghost.style.translate = `${x}px ${y}px`;
			const { area, width } = drag;
			const target = x < area.left + area.width / 2 ? "left" : "right";
			if (target === drag.target) return;
			drag.target = target;
			Object.assign(drag.zone.style, {
				left: `${target === "left" ? area.left : area.right - width}px`,
				top: `${area.top}px`,
				width: `${width}px`,
				height: `${area.height}px`,
			});
			drag.zone.dataset.current = String(target === side);
			drag.zone.firstChild.textContent =
				target === side ? "松手保持原位置" : `松手放到聊天区${target === "left" ? "左" : "右"}侧`;
		}
		function startDrag() {
			const chat = conversation.getBoundingClientRect();
			const own = panel.getBoundingClientRect();
			const left = Math.min(chat.left, own.left);
			const right = Math.max(chat.right, own.right);
			drag.moving = true;
			drag.area = { left, right, width: right - left, top: own.top, height: own.height };
			drag.width = Math.min(own.width, (right - left) / 2);
			drag.zone = element("div", "panel-drop-zone");
			drag.zone.append(element("span"));
			drag.ghost = element("div", "panel-drag-ghost");
			drag.ghost.append(
				icon(mode === "git" ? "git" : mode === "side" ? "side-chat" : "folder"),
				element("span", "", mode === "git" ? "Git 变更" : mode === "side" ? "侧边追问" : "文件"),
			);
			for (const node of [drag.zone, drag.ghost]) node.setAttribute("aria-hidden", "true");
			document.body.append(drag.zone, drag.ghost);
			workbench.dataset.panelDragging = "true";
			getSelection()?.removeAllRanges();
		}
		function endDrag(commit) {
			if (!drag) return;
			const { pointer, moving, target, zone, ghost } = drag;
			drag = undefined;
			if (header.hasPointerCapture(pointer)) header.releasePointerCapture(pointer);
			zone?.remove();
			ghost?.remove();
			delete workbench.dataset.panelDragging;
			if (!moving) return;
			// 松手处的控件仍会收到一次点击，拖动结束后吞掉它，避免误切标签或关闭面板。
			const swallow = (event) => {
				event.preventDefault();
				event.stopPropagation();
			};
			addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => removeEventListener("click", swallow, { capture: true }));
			if (commit && target && target !== side) placePanel(target);
		}
		header.addEventListener("pointerdown", (event) => {
			if (
				event.button !== 0 ||
				drag ||
				event.target.closest(dragExempt) ||
				narrow.matches ||
				panel.dataset.maximized === "true"
			)
				return;
			drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moving: false };
			header.setPointerCapture(event.pointerId);
		});
		header.addEventListener("pointermove", (event) => {
			if (drag?.pointer !== event.pointerId) return;
			// 移出点击容差后才进入拖动，单击或细微抖动不会改变布局。
			if (!drag.moving && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
			if (!drag.moving) startDrag();
			showDrop(event.clientX, event.clientY);
		});
		header.addEventListener("pointerup", (event) => {
			if (drag?.pointer === event.pointerId) endDrag(true);
		});
		header.addEventListener("pointercancel", () => endDrag(false));
		header.addEventListener("lostpointercapture", () => endDrag(false));
		addEventListener("blur", () => endDrag(false));
		addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || !drag) return;
				// 先于面板的 Esc 收起处理，只取消本次拖动。
				event.preventDefault();
				event.stopImmediatePropagation();
				endDrag(false);
			},
			true,
		);
		document.addEventListener("keydown", (event) => {
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				!panel.hidden &&
				(panel.contains(event.target) || event.target === toggle) &&
				!document.querySelector("dialog[open], :popover-open")
			) {
				event.preventDefault();
				if (panel.dataset.maximized === "true") maximize(false);
				else display(false);
			}
		});

		return {
			/** 绑定当前会话并清除上一会话的目录和预览。@param {object} next 当前选中会话 @param {boolean} initialized 工作台就绪状态 @returns {void} */
			setSession(next, initialized) {
				const ids = new Set((next?.attachments ?? []).map((ref) => ref.id));
				if (ids.size !== attached.size || [...ids].some((key) => !attached.has(key))) {
					attached = ids;
					for (const add of panel.querySelectorAll(".panel-add, #panel-reference:not([hidden])")) updateReference(add);
				}
				if (selected?.id === next?.id && ready === initialized) {
					if (selected?.workspace !== next?.workspace) {
						selected = next;
						breadcrumbs();
					}
					if (attachment && attachment.request == null && !ids.has(attachment.id)) {
						file = "";
						attachment = undefined;
						void load();
					}
					return;
				}
				change = undefined;
				attachment = undefined;
				choices = undefined;
				selected = next;
				ready = initialized;
				folders = [];
				file = "";
				opener = toggle;
				void load();
			},
			/**
			 * 切到侧边追问页并打开右栏。
			 * @param {HTMLElement} [trigger] 收起时返回焦点的按钮
			 * @returns {void}
			 */
			showSide(trigger) {
				setMode("side");
				opener = trigger ?? toggle;
				if (panel.hidden) display(true);
				else void load();
			},
			/**
			 * 当前会话有无侧边追问：没有时隐藏标签，正在显示时回到文件页。
			 * @param {boolean} available 是否有侧边追问
			 * @returns {void}
			 */
			sideAvailable(available) {
				by("panel-side").hidden = !available;
				if (available || mode !== "side") return;
				setMode("files");
				void load();
			},
			/** 从输入框打开当前工作区的文件列表。@param id 动作所属会话 @param trigger 返回焦点的按钮 @returns 无 */
			browseFiles(id, trigger) {
				if (selected?.id !== id) return;
				setMode("files");
				attachment = undefined;
				choices = undefined;
				file = "";
				opener = trigger;
				display(true);
			},
			/** 从草稿或消息读取附件。@param ref 附件引用 @param request 历史请求标识 @param trigger 来源按钮 @returns 无 */
			previewAttachment(ref, request, trigger) {
				if (!selected) return;
				setMode("files");
				choices = undefined;
				attachment = { id: ref.id, request };
				file = ref.name;
				opener = trigger;
				display(true);
			},
			/**
			 * 从交付文件或回复中的路径进入预览；有多个同名候选时先列出候选。
			 * @param {string} path 工作区相对路径
			 * @param {HTMLElement} trigger 来源按钮
			 * @param {string[]} [candidates] 同名文件的相对路径
			 * @returns {void}
			 */
			preview(path, trigger, candidates) {
				if (!selected) return;
				setMode("files");
				attachment = undefined;
				opener = trigger;
				choices = candidates?.length ? { name: path, paths: candidates } : undefined;
				folders = choices ? [] : path.split(/[\\/]/);
				file = choices ? "" : folders.pop();
				display(true);
			},
		};
	}
	window.createWorkspacePanel = createWorkspacePanel;
})();
