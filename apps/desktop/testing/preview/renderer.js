const api = window.flowerPreview;
const element = (id) => document.getElementById(id);
const directory = element("directory");
const file = element("file");
const task = element("task");
const start = element("start");
const cancel = element("cancel");
const retry = element("retry");
const output = element("output");
const status = element("run-status");
const coreStatus = element("core-status");
const history = element("history");
const statusLabels = {
	queued: "等待运行",
	running: "正在运行",
	cancelling: "正在取消",
	succeeded: "已完成",
	failed: "未完成",
	denied: "未获准运行",
	cancelled: "已取消",
	interrupted: "上次运行已中断",
};
let catalog;
let ready = false;
let active = false;
let canCancel = false;
let retryTask;

function options(select, values) {
	select.replaceChildren(...values.map(({ id, title }) => new Option(title, id)));
}

function syncControls() {
	directory.disabled = file.disabled = task.disabled = active;
	start.disabled = !ready || !file.value || active;
	cancel.disabled = !active || !canCancel;
	retry.hidden = !retryTask || !ready || active;
}

function setCore(core) {
	coreStatus.dataset.state = core;
	ready = core === "ready";
	coreStatus.textContent = ready ? "核心已就绪" : core === "failed" ? "核心未能启动，请重开应用" : "核心启动中";
	if (core === "failed") {
		active = false;
		status.textContent = "核心连接已结束";
	}
	syncControls();
	if (ready && catalog) void refreshHistory(true);
}

async function refreshHistory(showLatest) {
	if (!ready) return;
	const sample = file.value;
	try {
		const records = await api.history(sample);
		if (sample !== file.value) return;
		history.replaceChildren(
			...records
				.slice()
				.reverse()
				.map((record) => {
					const row = document.createElement("li");
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = `${record.input} · ${statusLabels[record.status]}`;
					button.addEventListener("click", () => {
						if (active) return;
						output.textContent = record.text || statusLabels[record.status];
						status.textContent = statusLabels[record.status];
					});
					row.append(button);
					return row;
				}),
		);
		element("empty").hidden = records.length !== 0;
		const latest = records.at(-1);
		retryTask = ["cancelled", "failed", "interrupted"].includes(latest?.status)
			? catalog.tasks.find(({ title }) => title === latest.input)?.id
			: undefined;
		if (showLatest && latest && !active) {
			status.textContent = statusLabels[latest.status];
			output.textContent = latest.text || statusLabels[latest.status];
		}
	} catch {
		status.textContent = "无法查看这份样例的历史";
	}
	syncControls();
}

function selectSample() {
	retryTask = undefined;
	status.textContent = "等待开始任务";
	output.textContent = "任务开始后，这里会显示读取进度和逐步生成的结果。";
	history.replaceChildren();
	element("empty").hidden = false;
	syncControls();
	void refreshHistory(true);
}

function selectDirectory() {
	options(
		file,
		catalog.samples
			.filter((record) => record.directory === directory.value)
			.map(({ id, title, file: name }) => ({ id, title: `${title} · ${name}` })),
	);
	selectSample();
}

async function submit(taskId) {
	if (!ready || active) return;
	active = true;
	canCancel = false;
	retryTask = undefined;
	task.value = taskId;
	output.textContent = "";
	status.textContent = "准备读取样例";
	syncControls();
	try {
		await api.submit(file.value, taskId);
	} catch {
		active = false;
		status.textContent = "任务未能开始，请重试";
		syncControls();
	}
}

directory.addEventListener("change", selectDirectory);
file.addEventListener("change", selectSample);
start.addEventListener("click", () => void submit(task.value));
retry.addEventListener("click", () => void submit(retryTask));
cancel.addEventListener("click", async () => {
	canCancel = false;
	syncControls();
	try {
		await api.cancel();
	} catch {
		status.textContent = "当前任务无法取消";
	}
});

const unsubscribe = api.subscribe(({ kind, core, event }) => {
	if (kind === "core") {
		setCore(core);
		return;
	}
	if (!active || event.sessionId !== file.value) return;
	switch (event.type) {
		case "queued":
		case "started":
			canCancel = true;
			status.textContent = event.type === "queued" ? "等待运行" : "正在运行";
			break;
		case "tool_started":
			status.textContent = "正在读取样例文件";
			break;
		case "tool_result":
			status.textContent = "样例已读取，生成结果中";
			break;
		case "text_delta":
			output.textContent += event.delta;
			break;
		case "cancelling":
			canCancel = false;
			status.textContent = "正在取消";
			break;
		case "terminal":
			active = false;
			canCancel = false;
			status.textContent = statusLabels[event.status];
			void refreshHistory(false);
			break;
	}
	syncControls();
});
window.addEventListener("unload", unsubscribe, { once: true });

void (async () => {
	try {
		const initial = await api.bootstrap();
		catalog = initial.catalog;
		options(
			directory,
			[...new Set(catalog.samples.map(({ directory }) => directory))].map((id) => ({ id, title: id })),
		);
		options(task, catalog.tasks);
		selectDirectory();
		setCore(initial.core);
		// 待控件绘制后再允许宿主启动核心。
		requestAnimationFrame(() => requestAnimationFrame(() => api.painted()));
	} catch {
		setCore("failed");
	}
})();
