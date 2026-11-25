(() => {
	const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
	const statuses = {
		queued: "排队中",
		starting: "正在准备",
		running: "运行中",
		cancelling: "正在取消",
		succeeded: "已完成",
		failed: "失败",
		denied: "已拒绝",
		cancelled: "已取消",
		interrupted: "已中断",
		missed: "已错过",
	};
	const cancellable = new Set(["queued", "starting", "running"]);
	const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
	const planExamples = [
		{
			title: "每日待办",
			icon: "checklist",
			description: "每天梳理未完成事项",
			frequency: "daily",
			prompt: "核对工作区资料中的未完成事项，按优先级列出待办、截止日期和出处。资料不足的字段标为待确认。",
		},
		{
			title: "每周工作摘要",
			icon: "report",
			description: "每周五汇总进展与风险",
			frequency: "weekly",
			weekday: 5,
			prompt: "根据工作区资料总结本周进展、待解决风险与下周安排。每项注明出处。",
		},
	];

	/**
	 * 在主区管理本机计划、技能与扩展。
	 * @param host 工作台受限接口
	 * @param actions 打开任务、确认、菜单与技能选用操作
	 * @returns 工作台状态同步入口
	 */
	function createAutomationSettings(host, { showTasks, confirm, selectSkill, showMenu, menuNavigation }) {
		const { element, button, feedback, icon } = window.flowerUI;
		const by = (id) => document.getElementById(id);
		const plans = by("automation-settings");
		const extensions = by("extension-settings");
		const autoForm = by("automation-form");
		const extForm = by("extension-run-form");
		const results = by("extension-result");
		const resultPanel = by("extension-result-panel");
		const extensionPath = by("extension-path");
		const planMenu = by("automation-plan-menu");
		const packageCatalog = by("extension-catalog");
		const filters = [...by("extension-filters").querySelectorAll("[data-package-filter]")];
		const packageList = by("extension-list");
		const packageDetail = by("extension-detail");
		const management = window.flowerManagement;
		const status = by("automation-status");
		const extStatus = by("extension-status");
		const editStatus = by("automation-edit-status");
		const runStatus = by("extension-run-status");
		const spaces = by("automation-workspace");
		const skills = by("automation-skill");
		const frequency = by("automation-frequency");
		const skillReader = window.flowerMarkdown.view(
			by("extension-skill-text"),
			(url) => void host.openReplyLink(url).catch((error) => feedback(extStatus, errorMessage(error), "error")),
		);
		let state;
		let planId;
		let extJob;
		let autoRevision = 0;
		let extensionRevision = 0;
		let skillRevision = 0;
		let detailId;
		let planTrigger;
		let libraryItems = [];
		let savedFilter = "all";
		let activeFilter = "all";
		let fromComposer = false;
		const themeFields = new Map(
			[
				["automation-workspace", "工作区"],
				["automation-frequency", "频率"],
				["automation-weekday", "星期"],
				["automation-permission", "权限"],
				["automation-skill", "技能"],
			].map(([id, label]) => {
				const field = by(id);
				const target = element("span", "theme-select");
				const trigger = `${id}-choice`;
				field.after(target);
				field.hidden = true;
				field.removeAttribute("required");
				field.parentElement.htmlFor = trigger;
				const control = window.flowerSelect(target, trigger, label, (value) => {
					field.value = value;
					field.dispatchEvent(new Event("change"));
					update();
				});
				function update() {
					control.render(
						Array.from(field.options, (option) => ({ value: option.value, label: option.label, title: option.title })),
						field.value,
					);
				}
				update();
				return [id, update];
			}),
		);

		function errorMessage(error) {
			return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") || "操作未完成。";
		}

		async function invoke(control, output, action) {
			if (control.disabled) return;
			control.disabled = true;
			feedback(output, "");
			try {
				return await action();
			} catch (error) {
				feedback(output, errorMessage(error), "error");
			} finally {
				control.disabled = control.id === "extension-install" && !selected();
			}
		}

		function selected() {
			return state?.draft ?? state?.sessions?.find(({ id }) => id === state.selected);
		}

		function syncWorkspace(value) {
			const current = selected();
			const choices = [...(state?.workspaces ?? [])];
			if (current && !choices.some(({ workspaceId }) => workspaceId === current.workspaceId)) choices.push(current);
			const desired = value ?? (spaces.value || current?.workspaceId);
			spaces.replaceChildren(new Option("请选择工作区", ""));
			for (const workspace of choices) {
				const choice = new Option(workspace.workspace, workspace.workspaceId);
				choice.title = workspace.path;
				spaces.append(choice);
			}
			spaces.value = choices.some(({ workspaceId }) => workspaceId === desired) ? desired : "";
			themeFields.get(spaces.id)();
		}

		async function syncSkills(desired = "") {
			const stamp = ++skillRevision;
			const workspace = spaces.value;
			skills.replaceChildren(new Option("不选择", ""));
			themeFields.get(skills.id)();
			if (!workspace) return;
			try {
				const items = await host.automationSkills(workspace);
				if (stamp !== skillRevision || workspace !== spaces.value) return;
				for (const item of items) skills.append(new Option(item.name, item.id));
				if (desired && !items.some(({ id }) => id === desired)) skills.append(new Option("原技能已停用或卸载", desired));
				skills.value = desired;
				themeFields.get(skills.id)();
			} catch (error) {
				if (stamp === skillRevision) feedback(editStatus, errorMessage(error), "error");
			}
		}

		function editMode(editing, existing = false) {
			autoForm.hidden = !editing;
			by("automation-overview").hidden = editing;
			by("automation-clock-note").hidden = editing;
			by("automation-toolbar").hidden = editing;
			by("automation-heading").textContent = editing ? (existing ? "编辑计划" : "新建计划") : "自动化";
			by("management-page").scrollTop = 0;
		}

		function showPlan(plan) {
			planId = plan?.id;
			editMode(true, Boolean(planId));
			feedback(editStatus, "");
			by("automation-name").value = plan?.title || "";
			by("automation-prompt").value = plan?.prompt || "";
			by("automation-time").value = plan?.time || "09:00";
			by("automation-permission").value = plan?.writeMode || "read";
			frequency.value = plan?.frequency || "daily";
			by("automation-weekday").value = String(plan?.weekday ?? 1);
			frequency.onchange();
			syncWorkspace(plan?.workspaceId ?? selected()?.workspaceId ?? "");
			void syncSkills(plan?.skill);
			for (const update of themeFields.values()) update();
			by("automation-name").focus();
		}

		function card(title, detail) {
			const row = element("article", "automation-card");
			const copy = element("div", "automation-copy");
			copy.append(element("strong", "", title), element("p", "", detail));
			const actions = element("div", "automation-actions");
			row.append(copy, actions);
			return { row, actions, copy };
		}

		function badge(label, state, variant = "management-badge") {
			const node = element("span", variant, label);
			if (state) node.dataset.state = state;
			return node;
		}

		function openPlanMenu(plan, trigger) {
			planTrigger = trigger;
			const next = [
				["编辑", () => showPlan(plan)],
				[
					plan.enabled ? "暂停" : "启用",
					async () => {
						await host.enableAutomation(plan.id, !plan.enabled);
						await renderPlans();
						if (!plans.hidden) plans.querySelector(`[data-plan="${plan.id}"] .plan-more`)?.focus();
					},
				],
				[
					"删除",
					async () => {
						if (!(await confirm(`删除「${plan.title}」？`, "这项计划以后不会再执行。", "删除"))) return;
						await host.removeAutomation(plan.id);
						await renderPlans();
						if (!plans.hidden) by("automation-new").focus();
					},
				],
			];
			planMenu.replaceChildren(
				...next.map(([title, perform]) => {
					const item = button(title, () => {
						planMenu.hidePopover();
						trigger.focus();
						void invoke(trigger, status, perform).then(() => {
							if (document.activeElement === document.body && trigger.isConnected) trigger.focus();
						});
					});
					item.setAttribute("role", "menuitem");
					return item;
				}),
			);
			showMenu(planMenu, trigger);
		}

		planMenu.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return menuNavigation(event);
			event.preventDefault();
			planMenu.hidePopover();
			planTrigger?.focus();
		});

		async function renderPlans() {
			const revision = ++autoRevision;
			try {
				const data = await host.automationState();
				if (plans.hidden || revision !== autoRevision) return;
				const list = by("automation-plans");
				const history = by("automation-history");
				list.replaceChildren();
				history.replaceChildren();
				if (!data.plans.length) {
					const examples = element("div", "automation-examples");
					for (const example of planExamples) {
						examples.append(directoryRow(example.title, example.description, example.icon, () => showPlan(example)));
					}
					list.append(element("h3", "management-list-heading", "从示例开始"), examples);
				} else list.append(element("h3", "management-list-heading", "计划"));
				const planRows = element("div", "management-surface automation-rows");
				for (const plan of data.plans) {
					const name =
						state?.workspaces?.find(({ workspaceId }) => workspaceId === plan.workspaceId)?.workspace ?? "工作区已移除";
					const timing = `${plan.frequency === "daily" ? "每天" : days[plan.weekday]} ${plan.time}`;
					const { row, actions } = card(plan.title, name);
					row.classList.add("automation-plan");
					row.dataset.plan = plan.id;
					const mark = element("span", "package-mark");
					mark.append(icon("clock"));
					const schedule = element("span", "plan-schedule", timing);
					row.prepend(mark);
					actions.before(schedule, badge(plan.enabled ? "已启用" : "已暂停", plan.enabled ? "enabled" : "paused"));
					const run = button(
						"立即执行",
						() =>
							void invoke(run, status, async () => {
								const id = await host.runAutomation(plan.id);
								if (!plans.hidden) {
									management.leave(false);
									showTasks(id);
								}
							}),
						"primary",
					);
					const more = button("", () => openPlanMenu(plan, more), "quiet icon-button plan-more");
					more.setAttribute("aria-label", "更多计划操作");
					more.setAttribute("aria-haspopup", "menu");
					more.append(icon("more"));
					run.disabled = data.runs.some(
						(record) => record.plan === plan.id && ["queued", "starting", "running", "cancelling"].includes(record.status),
					);
					actions.append(run, more);
					planRows.append(row);
				}
				if (planRows.childElementCount) list.append(planRows);
				if (!data.runs.length) return;
				const recent = element("div", "management-surface automation-rows");
				history.append(element("h3", "management-list-heading", "最近执行"), recent);
				for (const record of data.runs.slice(0, 20)) {
					const waiting = record.status === "queued" && !state?.model;
					const { row, actions, copy } = card(record.title, dateFormat.format(record.at));
					row.dataset.run = record.id;
					actions.before(badge(waiting ? "等待模型" : (statuses[record.status] ?? record.status), record.status));
					if (record.result) copy.append(element("p", "", record.result));
					actions.append(
						button(
							"查看任务",
							() => {
								management.leave(false);
								showTasks(record.id);
							},
							"quiet",
						),
					);
					if (cancellable.has(record.status)) {
						const cancel = button("取消", () => void invoke(cancel, status, () => host.cancelAutomation(record.id)), "quiet");
						actions.append(cancel);
					}
					recent.append(row);
				}
			} catch (error) {
				if (!plans.hidden && revision === autoRevision) feedback(status, errorMessage(error), "error");
			}
		}

		function directoryRow(title, description, symbol, open) {
			const entry = button("", open, "directory-row");
			entry.setAttribute("aria-label", title);
			const mark = element("span", "package-mark");
			mark.append(icon(symbol));
			const copy = element("span", "directory-copy");
			copy.append(element("strong", "", title), element("span", "directory-caption", description));
			entry.append(mark, copy, icon("forward"));
			return entry;
		}

		function empty(symbol, title, message) {
			const node = element("div", "management-empty");
			const mark = element("span", "management-empty-mark");
			mark.append(icon(symbol));
			node.append(mark, element("h3", "", title), element("p", "", message));
			return node;
		}

		function packageType(item) {
			return item.kind === "skill" ? "skill" : "extension";
		}

		function packageBadges(item) {
			return [
				badge(item.kind === "skill" ? "技能" : "扩展", "", "management-badge package-type"),
				badge(item.enabled ? "已启用" : "已停用", item.enabled ? "enabled" : "paused"),
			];
		}

		function clearExtensionResult() {
			resultPanel.hidden = true;
			results.hidden = true;
			results.textContent = "";
			by("extension-result-summary").textContent = "";
			feedback(runStatus, "");
		}

		function resetExtensionRun() {
			extJob = undefined;
			extForm.hidden = true;
			extensionPath.value = "";
			clearExtensionResult();
		}

		function updateRunToggle(control) {
			const expanded = !extForm.hidden;
			control.textContent = expanded ? "收起试运行" : "试运行";
			control.classList.toggle("quiet", expanded);
			control.classList.toggle("primary", !expanded);
			control.setAttribute("aria-expanded", String(expanded));
		}

		function showPackageList() {
			detailId = undefined;
			packageDetail.hidden = true;
			packageCatalog.hidden = false;
			by("extension-format").hidden = false;
			by("extension-toolbar").hidden = false;
			by("extension-heading").textContent = "技能与扩展";
			skillReader.update("");
			resetExtensionRun();
		}

		function showPackage(extension, current, focus = true) {
			const skill = extension.kind === "skill";
			detailId = extension.id;
			packageCatalog.hidden = true;
			by("extension-toolbar").hidden = true;
			by("extension-format").hidden = true;
			packageDetail.hidden = false;
			by("extension-heading").textContent = extension.name;
			by("extension-description").textContent = extension.description;
			const identity = by("extension-identity");
			identity.replaceChildren(...packageBadges(extension));
			if (!skill)
				identity.append(
					element("span", "extension-ability", extension.action === "count-lines" ? "统计匹配行" : "提取匹配行"),
				);
			skillReader.update(skill ? extension.body : "");
			const run = button(
				skill ? "用于本次对话" : "试运行",
				() => {
					if (selected()?.id !== current.id) return;
					if (skill) {
						selectSkill({ id: extension.id, name: extension.name });
						management.leave(false);
						by("prompt").focus();
					} else {
						const opening = extForm.hidden;
						// 收起时仅作废这次试运行和它的结果，输入路径仍属于当前详情。
						extJob = opening ? { id: current.id, extension: extension.id } : undefined;
						extForm.hidden = !opening;
						clearExtensionResult();
						updateRunToggle(run);
						(opening ? extensionPath : run).focus();
					}
				},
				"primary",
			);
			run.disabled = !extension.enabled;
			if (!skill) {
				run.id = "extension-run-toggle";
				run.setAttribute("aria-controls", extForm.id);
				updateRunToggle(run);
			}
			const toggle = button(
				extension.enabled ? "停用" : "启用",
				() =>
					void invoke(toggle, extStatus, async () => {
						await host.enableLocalExtension(current.id, extension.id, !extension.enabled);
						resetExtensionRun();
						await renderExtensions();
						if (!extensions.hidden && detailId === extension.id) by("extension-detail-toggle")?.focus();
					}),
				"secondary",
			);
			toggle.id = "extension-detail-toggle";
			const remove = button(
				"卸载",
				() =>
					void invoke(remove, extStatus, async () => {
						const accepted = await confirm(`卸载「${extension.name}」？`, "该工作区将移除此本地包。", "卸载");
						if (!accepted || selected()?.id !== current.id) return;
						await host.uninstallLocalExtension(current.id, extension.id);
						if (!extensions.hidden) {
							showPackageList();
							await renderExtensions();
							by("extension-install").focus();
						}
					}),
				"quiet",
			);
			by("extension-detail-actions").replaceChildren(toggle, remove, run);
			if (focus) {
				feedback(extStatus, "");
				by("management-page").scrollTop = 0;
				by("extension-heading").focus();
			}
		}

		function drawLibrary() {
			for (const filter of filters)
				filter.setAttribute("aria-pressed", String(filter.dataset.packageFilter === activeFilter));
			const current = selected();
			const items = libraryItems.filter((item) => activeFilter === "all" || packageType(item) === activeFilter);
			packageList.replaceChildren();
			if (!current) {
				packageList.append(empty("folder", "选择工作区", "技能与扩展按工作区管理。"));
			} else if (!items.length) {
				const filtered = activeFilter !== "all" && libraryItems.length > 0;
				packageList.append(
					empty(
						"sparkle",
						filtered ? (activeFilter === "skill" ? "暂无技能" : "暂无扩展") : "暂无技能与扩展",
						filtered ? "切换到「全部」查看已安装项。" : "可以导入 Markdown 技能或 JSON 扩展。",
					),
				);
			}
			for (const item of items) {
				const kind = packageType(item);
				const row = directoryRow(item.name, item.description, kind === "skill" ? "document" : "sparkle", () =>
					showPackage(item, current),
				);
				row.dataset.extension = item.id;
				row.dataset.packageKind = kind;
				const metadata = element("span", "directory-meta");
				metadata.id = `package-meta-${item.id}`;
				metadata.append(...packageBadges(item));
				row.setAttribute("aria-describedby", metadata.id);
				row.lastElementChild.before(metadata);
				packageList.append(row);
			}
		}

		async function renderExtensions() {
			const revision = ++extensionRevision;
			const current = selected();
			const workspace = by("extension-workspace");
			workspace.textContent = current?.workspace ?? "尚未选择工作区";
			workspace.title = current?.path ?? "";
			by("extension-install").hidden = by("extension-install").disabled = !current;
			const choose = by("extension-choose-workspace");
			choose.classList.toggle("primary", !current);
			choose.classList.toggle("quiet", Boolean(current));
			try {
				const modules = current ? await host.listLocalExtensions(current.id) : [];
				if (extensions.hidden || revision !== extensionRevision) return;
				libraryItems = modules;
				drawLibrary();
				const detail = modules.find(({ id }) => id === detailId);
				if (detail) showPackage(detail, current, false);
				else if (detailId) showPackageList();
			} catch (error) {
				if (!extensions.hidden && revision === extensionRevision) feedback(extStatus, errorMessage(error), "error");
			}
		}

		for (const filter of filters) {
			filter.onclick = () => {
				activeFilter = filter.dataset.packageFilter;
				if (!fromComposer) savedFilter = activeFilter;
				feedback(extStatus, "");
				drawLibrary();
			};
		}

		function backToPlans() {
			editMode(false);
			by("automation-new").focus();
		}
		plans.addEventListener("managemententer", () => {
			editMode(false);
			feedback(status, "");
			void renderPlans();
		});
		plans.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || event.isComposing || autoForm.hidden || document.querySelector(":popover-open"))
				return;
			event.preventDefault();
			backToPlans();
		});
		extensions.addEventListener("managemententer", () => {
			activeFilter = fromComposer ? "skill" : savedFilter;
			for (const filter of filters)
				filter.setAttribute("aria-pressed", String(filter.dataset.packageFilter === activeFilter));
			showPackageList();
			packageList.replaceChildren();
			feedback(extStatus, "");
			by("extension-format").open = false;
			void renderExtensions();
		});
		extensions.addEventListener("managementleave", () => {
			extensionRevision++;
			fromComposer = false;
			libraryItems = [];
			showPackageList();
		});
		function leavePackageDetail() {
			const row = Array.from(packageList.children).find(({ dataset }) => dataset.extension === detailId);
			showPackageList();
			(row ?? by("extension-install")).focus();
		}
		by("extension-detail-back").onclick = leavePackageDetail;
		extensions.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || event.isComposing || !detailId) return;
			event.preventDefault();
			if (!extForm.hidden) by("extension-run-toggle").click();
			else leavePackageDetail();
		});
		by("automation-new").onclick = () => showPlan();
		by("automation-cancel-edit").onclick = backToPlans;
		by("automation-tasks").onclick = () => {
			management.leave(false);
			showTasks();
		};
		by("automation-choose-workspace").onclick = (event) =>
			void invoke(event.currentTarget, editStatus, async () => {
				const id = await host.chooseWorkspace();
				if (id && selected()?.id === id) {
					syncWorkspace(selected().workspaceId);
					await syncSkills();
				}
			});
		spaces.onchange = () => void syncSkills();
		by("extension-choose-workspace").onclick = (event) =>
			void invoke(event.currentTarget, extStatus, () => host.chooseWorkspace());
		frequency.onchange = () => {
			by("automation-weekday").parentElement.hidden = frequency.value !== "weekly";
		};
		autoForm.addEventListener("submit", (event) => {
			event.preventDefault();
			void invoke(autoForm.querySelector("[type=submit]"), editStatus, async () => {
				if (!spaces.value) throw new Error("请选择工作区。");
				await host.saveAutomation(planId, {
					title: by("automation-name").value,
					workspaceId: spaces.value,
					prompt: by("automation-prompt").value,
					frequency: frequency.value,
					time: by("automation-time").value,
					weekday: Number(by("automation-weekday").value),
					writeMode: by("automation-permission").value,
					...(skills.value && { skill: skills.value }),
				});
				if (!plans.hidden) backToPlans();
				await renderPlans();
			});
		});
		by("extension-install").onclick = (event) =>
			void invoke(event.currentTarget, extStatus, async () => {
				const current = selected();
				if (!current) return;
				const installed = await host.installLocalExtension(current.id);
				if (!installed || extensions.hidden || selected()?.id !== current.id) return;
				if (activeFilter !== "all" && activeFilter !== packageType(installed)) {
					activeFilter = "all";
					if (!fromComposer) savedFilter = activeFilter;
				}
				await renderExtensions();
				feedback(extStatus, `已导入「${installed.name}」。`);
			});
		extForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const job = extJob;
			if (!job) return;
			void invoke(extForm.querySelector("[type=submit]"), runStatus, async () => {
				clearExtensionResult();
				const result = await host.runLocalExtension(job.id, job.extension, extensionPath.value.trim()).catch((error) => {
					if (job === extJob) throw error;
				});
				if (job !== extJob) return;
				const contents = (result.matches ?? []).map(({ line, text }) => `${line}  ${text}`);
				by("extension-result-summary").textContent =
					`${result.path} · 匹配 ${result.matched} 行${result.truncated ? "（节选）" : ""}`;
				results.textContent = contents.join("\n");
				results.hidden = !contents.length;
				resultPanel.hidden = false;
			});
		});

		return {
			/** 从输入框进入统一目录并定位技能。@param {HTMLElement} trigger 输入区入口 @returns {void} */
			openExtensions(trigger) {
				fromComposer = true;
				management.show("extensions", trigger);
			},
			sync(next) {
				const prior = selected();
				state = next;
				const current = selected();
				if (prior?.workspaceId !== current?.workspaceId) {
					savedFilter = "all";
					activeFilter = fromComposer ? "skill" : savedFilter;
				}
				if (!plans.hidden && !autoForm.hidden && prior?.id !== current?.id) {
					syncWorkspace(current?.workspaceId);
					void syncSkills();
				}
				if (!extensions.hidden && prior?.id !== current?.id) {
					showPackageList();
					libraryItems = [];
					packageList.replaceChildren();
					feedback(extStatus, "");
					void renderExtensions();
				}
			},
			refresh() {
				if (!plans.hidden) void renderPlans();
			},
		};
	}

	window.createAutomationSettings = createAutomationSettings;
})();
