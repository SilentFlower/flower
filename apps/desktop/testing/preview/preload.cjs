const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flowerPreview", {
	bootstrap: () => ipcRenderer.invoke("preview:bootstrap"),
	history: (sample) => ipcRenderer.invoke("preview:history", sample),
	submit: (sample, task) => ipcRenderer.invoke("preview:submit", sample, task),
	cancel: () => ipcRenderer.invoke("preview:cancel"),
	painted: () => ipcRenderer.send("preview:paint"),
	subscribe(callback) {
		const listener = (_event, message) => callback(message);
		ipcRenderer.on("preview:update", listener);
		return () => ipcRenderer.removeListener("preview:update", listener);
	},
});
