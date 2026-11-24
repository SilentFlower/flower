/** 系统文件管理器的名称随平台变化。 */
export const revealLabel =
	process.platform === "darwin"
		? "在访达中显示"
		: process.platform === "win32"
			? "在资源管理器中显示"
			: "在文件管理器中显示";

/**
 * 按右键位置生成原生菜单项：输入框给出编辑操作，选中文字可复制，图片可复制。
 * @param {Electron.ContextMenuParams} params Chromium 提供的右键参数
 * @param {Electron.WebContents} contents 当前页面，用于复制图片
 * @returns {Electron.MenuItemConstructorOptions[]} 菜单项；为空时不弹出菜单
 */
export function contextMenuItems(params, contents) {
	if (params.isEditable) {
		const flags = params.editFlags ?? {};
		return [
			{ label: "剪切", role: "cut", enabled: Boolean(flags.canCut) },
			{ label: "复制", role: "copy", enabled: Boolean(flags.canCopy) },
			{ label: "粘贴", role: "paste", enabled: Boolean(flags.canPaste) },
			{ type: "separator" },
			{ label: "全选", role: "selectAll", enabled: Boolean(flags.canSelectAll) },
		];
	}
	const items = [];
	if (params.selectionText?.trim()) items.push({ label: "复制", role: "copy" });
	if (params.mediaType === "image" && params.hasImageContents)
		items.push({ label: "复制图片", click: () => contents.copyImageAt(params.x, params.y) });
	return items;
}
