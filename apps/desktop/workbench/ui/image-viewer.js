(() => {
	const by = (id) => document.getElementById(id);
	const dialog = by("image-viewer");
	const stage = by("image-stage");
	const picture = by("image-full");
	const status = by("image-status");
	const zoom = by("image-zoom");
	let revision = 0;
	let activeUrl;
	let activeSession;
	let opener;

	function release() {
		revision++;
		picture.removeAttribute("src");
		if (activeUrl) URL.revokeObjectURL(activeUrl);
		activeUrl = undefined;
	}

	function setZoom(expanded) {
		const fitted = Math.min(
			picture.naturalWidth,
			stage.clientWidth,
			stage.clientHeight * (picture.naturalWidth / (picture.naturalHeight || 1)),
		);
		stage.dataset.zoom = String(expanded);
		zoom.setAttribute("aria-pressed", String(expanded));
		zoom.title = expanded ? "适应窗口" : "放大图片";
		zoom.setAttribute("aria-label", zoom.title);
		zoom.querySelector("use").setAttribute("href", expanded ? "#icon-zoom-out" : "#icon-zoom-in");
		if (expanded) {
			// 小图也支持看细节，大图至少按原始像素显示。
			picture.width = Math.ceil(Math.max(picture.naturalWidth, fitted * 2));
		} else {
			picture.removeAttribute("width");
			stage.scrollTo(0, 0);
		}
	}

	/** 打开放大图，图片在关闭或切换会话后释放。@param name 文件名 @param load 读取原始图片的函数 @param trigger 来源按钮 @returns 无 */
	async function open(name, load, trigger) {
		release();
		const stamp = revision;
		opener = trigger;
		setZoom(false);
		by("image-title").textContent = name;
		by("image-size").textContent = "";
		status.hidden = false;
		status.textContent = "正在打开图片…";
		picture.hidden = true;
		picture.alt = name;
		zoom.disabled = true;
		if (!dialog.open) dialog.showModal();
		try {
			const blob = await load();
			if (stamp !== revision || !dialog.open) return;
			activeUrl = URL.createObjectURL(blob);
			picture.src = activeUrl;
			await picture.decode();
			if (stamp !== revision || !dialog.open) return;
			by("image-size").textContent = `${picture.naturalWidth} × ${picture.naturalHeight}`;
			picture.hidden = false;
			status.hidden = true;
			zoom.disabled = false;
		} catch {
			if (stamp === revision && dialog.open) status.textContent = "图片暂时无法读取，请检查文件后重试。";
		}
	}
	zoom.addEventListener("click", () => setZoom(stage.dataset.zoom !== "true"));
	picture.addEventListener("click", () => setZoom(stage.dataset.zoom !== "true"));
	by("image-close").addEventListener("click", () => dialog.close());
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
	});
	dialog.addEventListener("close", () => {
		if (dialog.open) return;
		release();
		if (opener?.isConnected && !opener.closest("[hidden], [inert]")) opener.focus({ preventScroll: true });
		opener = undefined;
	});

	const tasks = new WeakMap();
	const observer = new IntersectionObserver(
		(entries) => {
			for (const { target, isIntersecting } of entries) {
				if (!isIntersecting) continue;
				observer.unobserve(target);
				void tasks.get(target)?.();
			}
		},
		{ rootMargin: "100px" },
	);
	async function toThumbnail(blob) {
		const bitmap = await createImageBitmap(blob);
		try {
			const scale = Math.min(1, 224 / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			return await new Promise((resolve, reject) =>
				canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("无法生成缩略图")))),
			);
		} finally {
			bitmap.close();
		}
	}

	/** 绑定可键盘打开的图片缩略图。@param control 图片按钮 @param ref 当前文件引用 @param request 历史消息标识或空 @returns 移除标签时释放图片的方法 */
	function bindThumbnail(control, ref, request) {
		const session = activeSession;
		const { element } = window.flowerUI;
		const thumb = element("img", "attachment-thumb");
		thumb.alt = "";
		thumb.decoding = "async";
		const preview = element("span", "attachment-thumb-surface");
		preview.append(thumb);
		control.prepend(preview);
		let url;
		let disposed = false;
		const load = async () => {
			const { mime, bytes } = await window.flower.attachmentImage(session, request, ref.id);
			return new Blob([bytes], { type: mime });
		};
		control.addEventListener("click", () => void open(ref.name, load, control));
		tasks.set(control, async () => {
			try {
				const blob = await load();
				if (disposed) return;
				const small = await toThumbnail(blob);
				if (disposed) return;
				url = URL.createObjectURL(small);
				thumb.src = url;
			} catch {
				if (!disposed) {
					thumb.remove();
					preview.append(window.flowerUI.icon("image"));
					control.title = `${ref.name} · 图片预览暂不可用`;
				}
			}
		});
		observer.observe(control);
		return () => {
			disposed = true;
			observer.unobserve(control);
			tasks.delete(control);
			if (url) URL.revokeObjectURL(url);
		};
	}

	/** 切换会话时关闭上一个会话的原图。@param id 当前会话标识 @returns 无 */
	function setSession(id) {
		if (activeSession !== id && dialog.open) dialog.close();
		activeSession = id;
	}
	window.flowerImages = { open, bindThumbnail, setSession };
})();
