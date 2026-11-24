window.flowerUI = (() => {
	/** 创建带可选样式和纯文本的 DOM 元素。@param {string} tag 标签 @param {string} style 样式类 @param {string} text 文本 @returns {HTMLElement} 元素 */
	function element(tag, style = "", text = "") {
		const node = document.createElement(tag);
		if (style) node.className = style;
		if (text) node.textContent = text;
		return node;
	}

	/** 创建原生按钮。@param {string} text 文本 @param {Function} click 点击动作 @param {string} variant 样式 @returns {HTMLButtonElement} 按钮 */
	function button(text, click, variant = "quiet") {
		const node = element("button", `button ${variant}`, text);
		node.type = "button";
		node.addEventListener("click", click);
		return node;
	}

	/** 引用工作台内置的装饰图标。@param {string} name 图标名 @returns {SVGSVGElement} 图标元素 */
	function icon(name) {
		const namespace = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(namespace, "svg");
		const use = document.createElementNS(namespace, "use");
		svg.setAttribute("class", "icon");
		svg.setAttribute("aria-hidden", "true");
		use.setAttribute("href", `#icon-${name}`);
		svg.append(use);
		return svg;
	}

	/** 创建与助手姓名并列展示的装饰头像。@param {string} size 尺寸类 @returns {HTMLImageElement} 助手头像 */
	function mark(size = "") {
		const node = element("img", `flower ${size}`.trim());
		node.src = "./ui/flower-avatar.webp";
		node.alt = "";
		node.decoding = "async";
		return node;
	}

	/** 更新状态反馈。@param {HTMLElement} node 状态区域 @param {string} text 内容 @param {string} tone 语气 @returns {void} */
	function feedback(node, text, tone = "neutral") {
		node.dataset.tone = tone;
		if (node.textContent !== text) node.textContent = text;
	}

	return { element, button, icon, mark, feedback };
})();
