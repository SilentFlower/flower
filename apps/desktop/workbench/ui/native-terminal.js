(() => {
	let attached = false;
	window.addEventListener("message", (event) => {
		if (attached || event.source !== window.parent || event.data?.type !== "flower-terminal" || event.ports.length !== 1)
			return;
		attached = true;
		const [port] = event.ports;
		if (!window.Terminal || !window.FitAddon?.FitAddon) {
			port.postMessage({ type: "error" });
			return;
		}
		const container = document.getElementById("terminal");
		const terminal = new window.Terminal({
			fontFamily: '"Cascadia Mono", Consolas, monospace',
			fontSize: 13,
			scrollback: 1500,
			cursorBlink: true,
			screenReaderMode: true,
			theme: event.data.theme,
			// 终端输出可能来自外部程序，不把输出里的链接和剪贴板动作交给桌面。
			linkHandler: { activate() {} },
		});
		const fit = new window.FitAddon.FitAddon();
		terminal.loadAddon(fit);
		terminal.open(container);
		terminal.textarea?.setAttribute("aria-label", "终端命令输入");
		terminal.onData((data) => port.postMessage({ type: "input", data }));
		terminal.parser.registerOscHandler(52, () => true);
		port.onmessage = ({ data }) => {
			if (data.type === "write") terminal.write(data.data);
			if (data.type === "theme") terminal.options.theme = data.theme;
		};
		function size(type) {
			fit.fit();
			const cols = Math.min(Math.max(terminal.cols, 2), 300);
			const rows = Math.min(Math.max(terminal.rows, 1), 200);
			port.postMessage({ type, cols, rows });
		}
		new ResizeObserver(() => size("size")).observe(container);
		size("ready");
		if (event.data.focus) terminal.focus();
	});
})();
