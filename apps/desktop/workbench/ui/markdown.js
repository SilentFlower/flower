window.flowerMarkdown = (() => {
	const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const escapeText = (value) => value.replace(/[&<>"']/g, (character) => entities[character]);

	function safeLink(value) {
		if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\p{Cc}\\]/u.test(value))
			return;
		try {
			const target = new URL(value);
			if (target.hostname && !target.username && !target.password && target.href.length <= 2048) return target.href;
		} catch {
			// 无效地址按原文显示。
		}
	}

	// 只认常见文件扩展名，避免把 example.com、v1.2 之类的行内代码当成文件。
	const fileExtension =
		/\.(?:md|mdx|txt|csv|tsv|xlsx|xlsm|xls|docx|doc|pdf|pptx|png|jpe?g|jpe|jfif|gif|webp|bmp|json|ya?ml|xml|html?|[cm]?[jt]sx?|py|css|sh|go|rs|java|sql|log|ini|toml)$/i;
	/**
	 * 把回复中提到的路径转成工作区相对路径。只接受常见扩展名的文件路径，工作区外与含 .. 的路径不解析。
	 * @param {string | undefined} root 当前会话工作区的本机路径
	 * @param {string} text 链接地址或行内代码
	 * @returns {string | undefined} 以 / 分隔的相对路径
	 */
	function workspacePath(root, text) {
		if (!root || typeof text !== "string") return;
		let value = text.trim().replace(/^[<"'`]+|[>"'`]+$/g, "");
		if (!value || value.length > 1024 || /\p{Cc}/u.test(value)) return;
		// 带协议的地址（含 file:）不是工作区路径；盘符路径允许继续按绝对路径处理。
		if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
		value = value.replaceAll("\\", "/");
		const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
		if (value.startsWith("/") || /^[a-z]:\//i.test(value)) {
			const windows = /^[a-z]:\//i.test(base) || base.startsWith("//");
			const head = value.slice(0, base.length);
			if (value[base.length] !== "/" || (windows ? head.toLowerCase() !== base.toLowerCase() : head !== base)) return;
			value = value.slice(base.length + 1);
		}
		const parts = value.replace(/^\.\//, "").split("/");
		if (parts.some((part) => !part || part === "." || part === "..")) return;
		const name = parts.at(-1);
		if (!fileExtension.test(name) || Array.from(name).length > 255) return;
		return parts.join("/");
	}

	// 解析器全局共用，路径按当前渲染的回复所属会话解析；parse 同步执行，渲染前后切换即可。
	let resolvePath;
	let checkPath;
	const imageFile = /\.(png|jpe?g|jpe|jfif|gif|webp|bmp)$/i;

	/**
	 * 解析并查询路径的核对结果。没有核对接口时视为已存在，保持旧调用方行为。
	 * @param {string} text 链接地址或行内代码
	 * @returns {{state: string, path?: string, candidates?: string[]} | undefined} 不像路径时为 undefined
	 */
	function linkPath(text) {
		const path = resolvePath?.(text);
		if (!path) return;
		return checkPath ? checkPath(path) : { state: "file", path };
	}

	function pathAttributes(found) {
		const name = escapeText(found.path);
		// 多个同名文件时点击列出候选，悬停提示同名数量。
		const title = found.state === "choices" ? `工作区中有 ${found.candidates.length} 个同名文件` : name;
		return `data-workspace-path="${name}" title="${escapeText(title)}"`;
	}

	function createParser(marked) {
		const renderer = {
			html({ raw, block }) {
				const literal = escapeText(raw);
				return block ? `<p class="markdown-literal">${literal}</p>` : literal;
			},
			image({ href, raw, text }) {
				const path = resolvePath?.(href);
				if (!path || !imageFile.test(path)) return `<span class="markdown-literal">${escapeText(raw)}</span>`;
				const name = escapeText(path);
				// 图片字节由宿主按工作区校验后读取，渲染后再填入 blob 地址。
				return `<img class="markdown-image" data-workspace-image="${name}" data-markdown-raw="${escapeText(raw)}" alt="${escapeText(text || path)}" title="${name}" tabindex="0" role="button">`;
			},
			codespan({ text }) {
				const code = escapeText(text);
				const found = linkPath(text);
				if (!found || found.state === "missing") return `<code>${code}</code>`;
				// 核对完成前与普通代码外观一致，宿主确认文件存在后再变成链接。
				if (found.state === "pending") return `<code data-path-pending="${escapeText(found.path)}">${code}</code>`;
				return `<code class="path-ref" ${pathAttributes(found)} role="link" tabindex="0">${code}</code>`;
			},
			link({ href, raw, tokens }) {
				const target = safeLink(href);
				const found = target ? undefined : linkPath(href);
				if (found?.state === "missing") return this.parser.parseInline(tokens);
				if (found?.state === "pending")
					return `<span data-path-pending="${escapeText(found.path)}">${this.parser.parseInline(tokens)}</span>`;
				if (found) return `<a href="#" ${pathAttributes(found)}>${this.parser.parseInline(tokens)}</a>`;
				if (!target) return escapeText(raw);
				const url = escapeText(target);
				// 地址只交给 Host 处理。保留原生链接的键盘激活语义。
				return `<a href="#" data-markdown-url="${url}" title="${url}">${this.parser.parseInline(tokens)}</a>`;
			},
			text({ escaped, text, tokens }) {
				if (tokens) return this.parser.parseInline(tokens);
				return escaped ? escapeText(text) : false;
			},
			code({ text }) {
				// 代码块与宽表格直接带上细滚动条样式，悬停显示滑块，流式重渲染时节点保持一致。
				return `<pre class="soft-scroll" tabindex="0" aria-label="代码块"><code>${escapeText(text)}</code></pre>\n`;
			},
			table(token) {
				const table = marked.Renderer.prototype.table.call(this, token);
				return `<div class="markdown-table-scroll soft-scroll" tabindex="0" role="region" aria-label="表格">${table}</div>\n`;
			},
		};
		return new marked.Marked({ gfm: true, renderer });
	}

	let parser = window.marked && createParser(window.marked);
	let ready;
	if (!parser) {
		// 源码直接启动时，npm 工作区依赖位于仓根。正式包从应用本地 node_modules 同步加载。
		const script = document.createElement("script");
		script.src = "../../../node_modules/marked/lib/marked.umd.js";
		ready = new Promise((resolve) => {
			script.onload = () => {
				if (window.marked) parser = createParser(window.marked);
				resolve();
			};
			script.onerror = resolve;
		});
		document.head.append(script);
	}

	function updateBlocks(root, fragment) {
		let current = root.firstChild;
		for (const incoming of [...fragment.childNodes]) {
			const next = current?.nextSibling;
			if (!current) root.append(incoming);
			else if (!current.isEqualNode(incoming)) current.replaceWith(incoming);
			current = next;
		}
		while (current) {
			const next = current.nextSibling;
			current.remove();
			current = next;
		}
	}

	/** 将助手回复渲染成 Markdown，原始回复由会话继续保存。
	 * @param {HTMLElement} root 单条回复的内容节点
	 * @param {(url: string) => void} openLink 可信链接交互
	 * @param {object} [paths] 工作区路径交互，只在聊天回复中提供
	 * @param {(text: string) => string | undefined} paths.resolve 把回复中的路径转成工作区相对路径
	 * @param {(path: string) => {state: "pending"|"file"|"choices"|"missing", path?: string, candidates?: string[]}} [paths.check] 查询宿主核对结果，不提供时视为文件存在
	 * @param {(path: string, trigger: HTMLElement) => void} paths.open 在右栏预览
	 * @param {(path: string, trigger: HTMLElement) => void} paths.menu 打开路径菜单
	 * @param {(root: HTMLElement, refresh: () => void) => void} paths.hydrate 为工作区图片填入内容、核对待定路径，结果到达后调用 refresh 重新渲染
	 * @param {(image: HTMLImageElement) => void} paths.openImage 放大查看图片
	 * @returns {{update: (source: string) => void}} 流式和历史共用的更新接口
	 */
	function view(root, openLink, paths) {
		let previous;
		const render = (source) => {
			if (source === previous) return;
			previous = source;
			root.hidden = !source;
			if (parser && source) {
				try {
					const template = document.createElement("template");
					// 标记由固定的 Marked 渲染器生成，HTML、图片、代码和地址在各自的入口处理。
					resolvePath = paths?.resolve;
					checkPath = paths?.check;
					try {
						template.innerHTML = parser.parse(source);
					} finally {
						resolvePath = undefined;
						checkPath = undefined;
					}
					updateBlocks(root, template.content);
					paths?.hydrate(root, refresh);
					return;
				} catch {
					// 极端文档仍可阅读并复制原文。
				}
			}
			root.textContent = source;
		};
		// 路径核对结果到达后按同一原文重新渲染，已缓存的结果在解析时同步生效。
		const refresh = () => {
			if (!previous) return;
			const source = previous;
			previous = undefined;
			render(source);
		};

		const pathTarget = (event) => {
			const target = event.target.closest?.("[data-workspace-path], img[data-workspace-image]");
			return target && root.contains(target) ? target : undefined;
		};
		root.addEventListener("click", (event) => {
			const target = paths && pathTarget(event);
			if (target) {
				event.preventDefault();
				if (!event.isTrusted) return;
				if (target.dataset.workspaceImage) paths.openImage(target);
				else paths.open(target.dataset.workspacePath, target);
				return;
			}
			const link = event.target.closest("a[data-markdown-url]");
			if (!link || !root.contains(link)) return;
			event.preventDefault();
			if (event.isTrusted) openLink(link.dataset.markdownUrl);
		});
		// 行内代码与图片不是原生可激活元素，补上回车与空格键。
		root.addEventListener("keydown", (event) => {
			const target = paths && pathTarget(event);
			if (!target || target.tagName === "A" || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			if (target.dataset.workspaceImage) paths.openImage(target);
			else paths.open(target.dataset.workspacePath, target);
		});
		root.addEventListener("contextmenu", (event) => {
			const target = paths && pathTarget(event);
			if (!target) return;
			event.preventDefault();
			paths.menu(target.dataset.workspacePath ?? target.dataset.workspaceImage, target);
		});
		ready?.then(() => {
			if (parser) refresh();
		});
		return { update: render };
	}

	return { view, workspacePath };
})();
