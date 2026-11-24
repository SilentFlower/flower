/** 判断窗口外框是否完整位于显示器工作区内。
 * @param {{x:number,y:number,width:number,height:number}} area 显示器可用工作区
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口外框
 * @returns {boolean} 完整位于工作区内时为 true
 */
export function containsBounds(area, bounds) {
	return (
		bounds.x >= area.x &&
		bounds.y >= area.y &&
		bounds.x + bounds.width <= area.x + area.width &&
		bounds.y + bounds.height <= area.y + area.height
	);
}

/** 计算为侧栏扩展后的窗口外框。
 * @param {{x:number,y:number,width:number,height:number}} bounds 当前窗口外框
 * @param {{x:number,y:number,width:number,height:number}} area 窗口所在显示器的可用工作区
 * @param {number} width 侧栏需要的窗口坐标宽度
 * @returns {{x:number,y:number,width:number,height:number}} 扩展后的外框，没有可用空间时与原外框相同
 */
export function expandedBounds(bounds, area, width) {
	const right = Math.max(0, area.x + area.width - bounds.x - bounds.width);
	const left = Math.max(0, bounds.x - area.x);
	const grow = Math.max(0, Math.min(Math.round(width), right + left, area.width - bounds.width));
	// 先占用右侧空余，缺口再向左平移补足：聊天区宽度优先于屏幕位置，且不越过工作区左缘。
	const shift = Math.max(0, grow - right);
	return { ...bounds, x: bounds.x - shift, width: bounds.width + grow };
}

/** 计算收起侧栏后的窗口外框。
 * @param {{before:object, after:object, contained:boolean}} record 扩展前后的外框及扩展前是否完整可见
 * @param {{x:number,y:number,width:number,height:number}} now 当前窗口外框
 * @param {number} minimumWidth 窗口允许的最小宽度
 * @param {(bounds:object) => {x:number,y:number,width:number,height:number}} areaOf 返回外框所在显示器工作区
 * @returns {{x:number,y:number,width:number,height:number}} 还原后的外框
 */
export function restoredBounds({ before, after, contained }, now, minimumWidth, areaOf) {
	// 只撤销扩展本身：保留用户在展开期间移动和调宽的差值，反复开关不会累积偏移。
	const width = Math.max(minimumWidth, now.width - (after.width - before.width));
	const target = { ...now, x: now.x + before.x - after.x, width };
	if (!contained) return target;
	const area = areaOf(target);
	return { ...target, x: Math.max(area.x, Math.min(target.x, area.x + area.width - width)) };
}

/** 计算分数缩放下外框取整偏差的一次性补偿目标。
 * @param {{x:number,y:number,width:number,height:number}} target 请求设置的外框
 * @param {{x:number,y:number,width:number,height:number}} actual 设置后回读的外框
 * @param {number} tolerance 视为取整偏差的最大差值
 * @returns {{x:number,y:number,width:number,height:number}|undefined} 需要补偿时返回修正外框，差值为零或超出容差时返回 undefined
 */
export function roundingCorrection(target, actual, tolerance = 2) {
	const keys = ["x", "y", "width", "height"];
	const deltas = keys.map((key) => actual[key] - target[key]);
	// 超出容差视为系统钳制或用户操作，保留系统结果，不反复调整。
	if (deltas.every((delta) => delta === 0) || deltas.some((delta) => Math.abs(delta) > tolerance)) return;
	return Object.fromEntries(keys.map((key, index) => [key, target[key] - deltas[index]]));
}
