(() => {
	const script = document.currentScript.src;
	let library;

	async function loadLibrary() {
		// 正式包在 app.asar 下安装依赖，直接运行源码时依赖提升至仓根。
		let root = new URL("../../node_modules/pdfjs-dist/", script);
		let pdf;
		try {
			pdf = await import(new URL("build/pdf.mjs", root).href);
		} catch {
			root = new URL("../../../../node_modules/pdfjs-dist/", script);
			pdf = await import(new URL("build/pdf.mjs", root).href);
		}
		return { pdf, root };
	}

	/** 在文件面板内按页绘制本机 PDF，面板关闭时释放文档和后台线程。
	 * @param {HTMLElement} container 预览容器
	 * @param {Uint8Array} bytes Host 已校验的文件数据
	 * @param {Function} status 更新当前预览的加载或错误状态
	 * @returns {Function} 销毁本次预览
	 */
	function preview(container, bytes, status) {
		const { button, element, icon } = window.flowerUI;
		const bar = element("div", "panel-pdf-controls");
		const count = element("span");
		count.setAttribute("role", "status");
		const pageArea = element("div", "panel-pdf-page");
		const previous = button("", () => goTo(number - 1), "icon-button");
		const next = button("", () => goTo(number + 1), "icon-button");
		for (const [control, label, symbol] of [
			[previous, "上一页", "back"],
			[next, "下一页", "forward"],
		]) {
			control.setAttribute("aria-label", label);
			control.title = label;
			control.append(icon(symbol));
			control.disabled = true;
		}
		bar.append(previous, count, next);
		container.append(bar, pageArea);
		let documentProxy;
		let loading;
		let drawing;
		let thread;
		let parser;
		let number = 1;
		let stopped = false;
		let generation = 0;
		let previousWidth = 0;
		let frame = 0;

		async function draw() {
			if (stopped || !documentProxy || pageArea.clientWidth < 1) return;
			const stamp = ++generation;
			drawing?.cancel();
			let page;
			try {
				page = await documentProxy.getPage(number);
				if (stopped || generation !== stamp) return;
				const natural = page.getViewport({ scale: 1 });
				const width = Math.max(1, pageArea.clientWidth);
				const scale = Math.min(
					(width * Math.min(devicePixelRatio, 2)) / natural.width,
					Math.sqrt(3_000_000 / (natural.width * natural.height)),
					8192 / Math.max(natural.width, natural.height),
				);
				const viewport = page.getViewport({ scale });
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.ceil(viewport.width));
				canvas.height = Math.max(1, Math.ceil(viewport.height));
				canvas.setAttribute("role", "img");
				canvas.setAttribute("aria-label", `PDF 第 ${number} 页`);
				drawing = page.render({ canvas, viewport });
				await drawing.promise;
				if (stopped || generation !== stamp) return;
				pageArea.replaceChildren(canvas);
				status();
			} catch {
				if (!stopped && generation === stamp) status("这一页未能显示，请刷新后重试。", true);
			} finally {
				// 已画好的 canvas 保留像素，无需继续缓存这一页的绘制指令和解码图像。
				page?.cleanup();
			}
		}

		function goTo(page) {
			if (!documentProxy || page < 1 || page > documentProxy.numPages) return;
			number = page;
			count.textContent = `${number} / ${documentProxy.numPages}`;
			previous.disabled = number === 1;
			next.disabled = number === documentProxy.numPages;
			status("正在绘制页面…");
			void draw();
		}

		const observer = new ResizeObserver(() => {
			if (previousWidth === pageArea.clientWidth) return;
			previousWidth = pageArea.clientWidth;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(draw);
		});
		observer.observe(pageArea);
		status("正在打开 PDF…");
		void (async () => {
			try {
				library ??= loadLibrary();
				const { pdf, root } = await library;
				if (stopped) return;
				thread = new Worker(new URL("build/pdf.worker.mjs", root), { type: "module", name: "flower-pdf" });
				parser = new pdf.PDFWorker({ port: thread });
				thread.addEventListener(
					"error",
					() => {
						if (!stopped) status("PDF 阅读器加载失败，请重新打开。", true);
						parser.destroy();
						thread.terminate();
					},
					{ once: true },
				);
				loading = pdf.getDocument({
					data: bytes,
					worker: parser,
					disableWorkerRendering: true,
					cMapUrl: new URL("cmaps/", root).href,
					cMapPacked: true,
					standardFontDataUrl: new URL("standard_fonts/", root).href,
					iccUrl: new URL("iccs/", root).href,
					wasmUrl: new URL("wasm/", root).href,
					useWasm: false,
					maxImageSize: 16_000_000,
				});
				documentProxy = await loading.promise;
				if (!stopped) goTo(1);
			} catch (error) {
				if (!stopped)
					status(error?.name === "PasswordException" ? "此 PDF 需要密码。" : "PDF 未能打开，请检查文件或刷新。", true);
			}
		})();
		return () => {
			stopped = true;
			observer.disconnect();
			cancelAnimationFrame(frame);
			drawing?.cancel();
			// 先让 PDF.js 完成在途消息的收尾，再销毁当前预览独占的线程。
			void Promise.resolve(loading?.destroy())
				.catch(() => {})
				.finally(() => {
					parser?.destroy();
					thread?.terminate();
				});
		};
	}
	window.previewWorkspacePDF = preview;
})();
