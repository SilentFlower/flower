(() => {
	const { element, icon, button } = window.flowerUI;

	/** 在草稿和已发送消息中使用相同的文件标签。@param root 标签容器 @param remove 可选的草稿移除回调 @param request 历史请求标识 @param preview 打开右栏的回调 @returns 更新附件列表的方法 */
	function view(root, remove, request, preview) {
		let previous;
		let releases = [];
		function dispose() {
			for (const release of releases) release();
			releases = [];
			previous = undefined;
		}
		function update(refs = [], session) {
			const signature = JSON.stringify([session, refs]);
			if (signature === previous) return;
			dispose();
			previous = signature;
			const focused = [...root.querySelectorAll("button")].indexOf(document.activeElement);
			root.hidden = refs.length === 0;
			root.replaceChildren(
				...refs.map((ref) => {
					const path = ref.id.startsWith("file:") ? ref.id.slice(5) : ref.name;
					const extension = ref.name.split(".").at(-1).toLowerCase();
					const chip = element("span", "file-chip");
					const sheet = ["xlsx", "csv", "tsv"].includes(extension);
					const image = ["png", "jpg", "jpeg", "jpe", "jfif", "webp"].includes(extension);
					chip.dataset.type = sheet ? "sheet" : image ? "image" : extension === "pdf" ? "pdf" : "document";
					const badge = element("span", "chip-icon");
					badge.append(icon(sheet ? "table" : image ? "image" : extension === "pdf" ? "report" : "document"));
					const duplicate = refs.some((other) => other.id !== ref.id && other.name === ref.name);
					const name = element("span", "chip-name", duplicate ? path : ref.name);
					chip.title = path;
					if (image) {
						const control = element("button", "attachment-image-open");
						control.type = "button";
						control.setAttribute("aria-label", `查看大图：${ref.name}`);
						control.title = path;
						control.append(name);
						releases.push(window.flowerImages.bindThumbnail(control, ref, request));
						chip.append(control);
					} else {
						const open = button("", (event) => preview(ref, request, event.currentTarget), "attachment-file-open");
						open.setAttribute("aria-label", `预览附件：${ref.name}`);
						open.append(badge, name);
						chip.append(open);
					}
					if (remove) {
						const control = button("", () => remove(ref.id), "chip-remove");
						control.title = `移除 ${path}`;
						control.setAttribute("aria-label", control.title);
						control.append(icon("panel-close"));
						chip.append(control);
					}
					return chip;
				}),
			);
			if (focused >= 0) {
				const controls = root.querySelectorAll("button");
				(controls[Math.min(focused, controls.length - 1)] ?? document.getElementById("prompt")).focus({
					preventScroll: true,
				});
			}
		}
		update.dispose = dispose;
		return update;
	}

	/** 将截图限制在适合放入模型请求的尺寸。@param file 剪贴板的图片文件 @returns PNG 字节 */
	async function screenshot(file) {
		if (file.size > 24 * 1024 * 1024) throw new Error("截图过大，请裁剪后粘贴。");
		// 已满足模型体积限制的 PNG 保留其原始分辨率，放大后仍可阅读小字。
		if (file.type === "image/png" && file.size <= 4 * 1024 * 1024) return new Uint8Array(await file.arrayBuffer());
		const bitmap = await createImageBitmap(file);
		try {
			const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob || blob.size > 4 * 1024 * 1024) throw new Error("截图过大，请裁剪后粘贴。");
			return new Uint8Array(await blob.arrayBuffer());
		} finally {
			bitmap.close();
		}
	}

	/**
	 * 判断粘贴的文本是否应转为附件：超过 2000 字或 20 行，或粘贴后会超出输入框上限。
	 * @param {string} text 粘贴的文本
	 * @param {HTMLTextAreaElement | undefined} input 接收粘贴的输入框
	 * @returns {boolean} 是否转为附件
	 */
	function longPaste(text, input) {
		if (!text) return false;
		if (text.length > 2000 || text.split(/\r\n|\r|\n/).length > 20) return true;
		// 输入框的 maxlength 会静默截断，替换选区后仍超限时同样转为附件。
		if (!input || !(input.maxLength > 0)) return false;
		return input.value.length - (input.selectionEnd - input.selectionStart) + text.length > input.maxLength;
	}

	/** 绑定输入卡的文件拖入和图片粘贴。@param composer 输入卡 @param host 桌面接口 @param workspace 取得或选择当前会话 @param action 操作与错误反馈包装 @returns 无 */
	function bind(composer, host, workspace, action) {
		const files = (event) => event.dataTransfer?.types.includes("Files");
		for (const type of ["dragover", "drop"])
			window.addEventListener(type, (event) => {
				if (files(event)) event.preventDefault();
			});
		composer.addEventListener("dragover", (event) => {
			if (!files(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			composer.dataset.drag = "true";
		});
		composer.addEventListener("dragleave", (event) => {
			if (!composer.contains(event.relatedTarget)) delete composer.dataset.drag;
		});
		composer.addEventListener("drop", (event) => {
			delete composer.dataset.drag;
			if (!files(event)) return;
			event.preventDefault();
			const dropped = [...event.dataTransfer.files];
			void action(async () => {
				const id = await workspace();
				if (id && dropped.length) await host.dropFiles(id, dropped);
			})();
		});
		composer.addEventListener("paste", (event) => {
			const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
			if (!images.length) {
				const text = event.clipboardData?.getData("text/plain") ?? "";
				const input = event.target instanceof HTMLTextAreaElement ? event.target : undefined;
				if (!longPaste(text, input)) return;
				event.preventDefault();
				void action(async () => {
					const id = await workspace();
					if (id) await host.pasteText(id, text);
				})();
				return;
			}
			event.preventDefault();
			void action(async () => {
				const id = await workspace();
				if (!id) return;
				for (const file of images) await host.pasteImage(id, await screenshot(file));
			})();
		});
	}

	window.flowerAttachments = { view, bind, longPaste };
})();
