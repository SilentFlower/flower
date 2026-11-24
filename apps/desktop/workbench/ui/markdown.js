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

	function createParser(marked) {
		const renderer = {
			html({ raw, block }) {
				const literal = escapeText(raw);
				return block ? `<p class="markdown-literal">${literal}</p>` : literal;
			},
			image({ raw }) {
				return `<span class="markdown-literal">${escapeText(raw)}</span>`;
			},
			link({ href, raw, tokens }) {
				const target = safeLink(href);
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
				return `<pre tabindex="0" aria-label="代码块"><code>${escapeText(text)}</code></pre>\n`;
			},
			table(token) {
				const table = marked.Renderer.prototype.table.call(this, token);
				return `<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="表格">${table}</div>\n`;
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
	 * @returns {{update: (source: string) => void}} 流式和历史共用的更新接口
	 */
	function view(root, openLink) {
		let previous;
		const render = (source) => {
			if (source === previous) return;
			previous = source;
			root.hidden = !source;
			if (parser && source) {
				try {
					const template = document.createElement("template");
					// 标记由固定的 Marked 渲染器生成，HTML、图片、代码和地址在各自的入口处理。
					template.innerHTML = parser.parse(source);
					updateBlocks(root, template.content);
					return;
				} catch {
					// 极端文档仍可阅读并复制原文。
				}
			}
			root.textContent = source;
		};

		root.addEventListener("click", (event) => {
			const link = event.target.closest("a[data-markdown-url]");
			if (!link || !root.contains(link)) return;
			event.preventDefault();
			if (event.isTrusted) openLink(link.dataset.markdownUrl);
		});
		ready?.then(() => {
			if (parser && previous) {
				const source = previous;
				previous = undefined;
				render(source);
			}
		});
		return { update: render };
	}

	return { view };
})();
