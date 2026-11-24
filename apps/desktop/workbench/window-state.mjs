import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { restoredBounds } from "./window-fit.mjs";

const minimum = { width: 640, height: 560 };

/** 求两个矩形的交集尺寸。@param {object} a 矩形 @param {object} b 矩形 @returns {{width: number, height: number}} 交集宽高 */
function overlap(a, b) {
	return {
		width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
		height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
	};
}

/**
 * 校验保存的窗口外框。尺寸不小于最小窗口，且标题栏至少有一段落在某个显示器工作区内，用户才能拖动或操作窗口。
 * @param {unknown} saved 保存的窗口状态
 * @param {{x:number,y:number,width:number,height:number}[]} areas 各显示器的可用工作区
 * @returns {{x:number,y:number,width:number,height:number} | undefined} 可恢复的外框；不可用时返回 undefined，由调用方使用默认尺寸
 */
export function restorableBounds(saved, areas) {
	if (!saved || typeof saved !== "object") return;
	const { x, y, width, height } = saved;
	if (![x, y, width, height].every(Number.isFinite)) return;
	const bounds = {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.max(minimum.width, Math.round(width)),
		height: Math.max(minimum.height, Math.round(height)),
	};
	const titlebar = { ...bounds, height: 45 };
	const area = areas.find((candidate) => {
		const visible = overlap(candidate, titlebar);
		return visible.width >= 120 && visible.height >= 30;
	});
	if (!area) return;
	// 显示器换成更小的分辨率时，尺寸不超过当前工作区。
	return {
		...bounds,
		width: Math.min(bounds.width, Math.max(minimum.width, area.width)),
		height: Math.min(bounds.height, Math.max(minimum.height, area.height)),
	};
}

/**
 * 计算应保存的外框：侧栏外扩期间扣除扩出的宽度与平移，下次启动时侧栏默认收起。
 * @param {{x:number,y:number,width:number,height:number}} normal 窗口的常规外框（最大化时为还原尺寸）
 * @param {{before:object, after:object, contained:boolean} | undefined} expansion 侧栏外扩记录
 * @param {number} minimumWidth 窗口允许的最小宽度
 * @param {(bounds:object) => {x:number,y:number,width:number,height:number}} areaOf 返回外框所在显示器工作区
 * @returns {{x:number,y:number,width:number,height:number}} 要保存的外框
 */
export function savedBounds(normal, expansion, minimumWidth, areaOf) {
	return expansion ? restoredBounds(expansion, normal, minimumWidth, areaOf) : normal;
}

/** 窗口创建前同步读取窗口状态。@param {string} path 状态文件 @returns {unknown} 保存的内容，缺失或损坏时为 undefined */
export function readWindowState(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * 同步原子写入窗口状态。关闭窗口后进程很快退出，异步写入可能来不及完成。
 * @param {string} path 状态文件
 * @param {{x:number,y:number,width:number,height:number,maximized:boolean}} state 窗口状态
 * @returns {void}
 */
export function writeWindowState(path, state) {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
	renameSync(temporary, path);
}
