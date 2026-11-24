/**
 * flower-observer 页面交互(原生 JS,事件委托,无构建)
 *
 * 职责:顶栏下拉跳转(URL 即状态)、列表行点击、tab 切换、树/平铺切换、
 * pretty/raw 切换、拦截表跳回执行流节点、running 详情页自动刷新。
 */
(() => {
	// 顶栏下拉:改 URL query 后整页跳转(切换条件时回到第 1 页)
	document.addEventListener("change", (event) => {
		if (!(event.target instanceof Element)) return;
		const select = event.target.closest("[data-nav-param]");
		if (!select) return;
		const url = new URL(location.href);
		// 详情页等无列表语义的路径:切板块/时间即回到列表
		if (url.pathname !== "/traces" && url.pathname !== "/metrics") url.pathname = "/traces";
		const key = select.dataset.navParam;
		if (select.value === "") {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, select.value);
		}
		url.searchParams.delete("page");
		location.href = url.toString();
	});

	/** tab 激活(执行流 / 产出) */
	function activateTab(name) {
		for (const tab of document.querySelectorAll("[data-tab]")) {
			tab.classList.toggle("active", tab.dataset.tab === name);
		}
		for (const panel of document.querySelectorAll("[data-panel]")) {
			panel.classList.toggle("hidden", panel.dataset.panel !== name);
		}
	}

	document.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;

		// 列表行点击跳详情(行内链接照常工作)
		const row = event.target.closest("tr[data-href]");
		if (row && !event.target.closest("a")) {
			location.href = row.dataset.href;
			return;
		}

		// tab 切换
		const tab = event.target.closest("[data-tab]");
		if (tab) {
			activateTab(tab.dataset.tab);
			return;
		}

		// 树状 ↔ 平铺切换(同一数据两种排序/缩进,SSR 双容器只切 display)
		const viewBtn = event.target.closest("[data-view-toggle]");
		if (viewBtn) {
			for (const btn of document.querySelectorAll("[data-view-toggle]")) {
				btn.classList.toggle("active", btn === viewBtn);
			}
			for (const view of document.querySelectorAll("[data-view]")) {
				view.classList.toggle("hidden", view.dataset.view !== viewBtn.dataset.viewToggle);
			}
			return;
		}

		// pretty ↔ raw 切换(同一 io 块内两个 pre)
		const rawBtn = event.target.closest("[data-raw-toggle]");
		if (rawBtn) {
			const body = rawBtn.closest(".io-body");
			if (!body) return;
			const rawPre = body.querySelector(".io-raw");
			const prettyPre = body.querySelector(".io-pretty");
			const showRaw = rawPre.classList.contains("hidden");
			rawPre.classList.toggle("hidden", !showRaw);
			prettyPre.classList.toggle("hidden", showRaw);
			rawBtn.classList.toggle("active", showRaw);
			return;
		}

		// 拦截表 → 执行流对应节点(先切 tab + 树状视图,再滚动高亮)
		const goto = event.target.closest("[data-goto-seq]");
		if (goto) {
			event.preventDefault();
			activateTab("flow");
			const treeBtn = document.querySelector('[data-view-toggle="tree"]');
			if (treeBtn) treeBtn.click();
			const node = document.getElementById(`seq-${goto.dataset.gotoSeq}`);
			if (node) {
				node.scrollIntoView({ behavior: "smooth", block: "center" });
				node.classList.add("flash");
				setTimeout(() => node.classList.remove("flash"), 1600);
			}
		}
	});

	// running 详情页自动刷新(整页 reload:浏览器自动恢复滚动位置,免客户端重渲染)
	const refreshMs = Number(document.body.dataset.refreshMs);
	if (Number.isFinite(refreshMs) && refreshMs > 0) {
		setTimeout(() => location.reload(), refreshMs);
	}

	/** 产品名 → 稳定 HSL 色(与服务端 layout.ts 的 productColor 同一哈希,保证跨页一致) */
	function productColor(product) {
		let hash = 0;
		for (const ch of product) {
			hash = (hash * 31 + ch.codePointAt(0)) | 0;
		}
		return `hsl(${Math.abs(hash) % 360} 55% 42%)`;
	}

	// 指标页:按天评审次数图(uPlot 时间序列,product 分组;数据由 SSR 内嵌 JSON 提供)
	const dailyHost = document.getElementById("daily-chart");
	const dailyData = document.getElementById("daily-chart-data");
	if (dailyHost && dailyData && typeof uPlot !== "undefined") {
		const daily = JSON.parse(dailyData.textContent);
		// x 轴:日期字符串 → 当天本地零点的 Unix 秒(uPlot 时间轴口径)
		const xs = daily.dates.map((date) => new Date(`${date}T00:00:00`).getTime() / 1000);
		const data = [xs, ...daily.counts];
		const series = [
			{},
			...daily.products.map((product) => ({
				label: product,
				stroke: productColor(product),
				width: 2,
				points: { show: true, size: 6 },
			})),
		];
		const chart = new uPlot(
			{
				width: Math.min(1240, dailyHost.clientWidth || 1240),
				height: 240,
				series,
				axes: [{}, { size: 44 }],
			},
			data,
			dailyHost,
		);
		// 跟随容器宽度(简单防溢出;指标页无复杂布局,resize 一次性重设即可)
		window.addEventListener("resize", () => {
			chart.setSize({ width: Math.min(1240, dailyHost.clientWidth || 1240), height: 240 });
		});
	}
})();
