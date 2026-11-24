import assert from "node:assert/strict";
import test from "node:test";
import { containsBounds, expandedBounds, restoredBounds, roundingCorrection } from "../workbench/window-fit.mjs";

const area = { x: 0, y: 0, width: 2560, height: 1392 };
const areaOf = () => area;

test("右侧空间足够时只向右扩展，收起后回到原外框且反复开关不漂移", () => {
	const before = { x: 400, y: 120, width: 1250, height: 760 };
	let now = before;
	for (let round = 0; round < 5; round++) {
		const after = expandedBounds(now, area, 500);
		assert.deepEqual(after, { ...before, width: 1750 });
		now = restoredBounds({ before: now, after, contained: true }, after, 640, areaOf);
		assert.deepEqual(now, before);
	}
});

test("右侧空间不足时向左补足缺口，工作区不够宽时由聊天区让出余量", () => {
	const nearRight = { x: 1200, y: 0, width: 1250, height: 760 };
	assert.deepEqual(expandedBounds(nearRight, area, 500), { ...nearRight, x: 810, width: 1750 });
	const wide = { x: 300, y: 0, width: 2000, height: 760 };
	assert.deepEqual(expandedBounds(wide, area, 900), { ...wide, x: 0, width: 2560 });
	const full = { x: 0, y: 0, width: 2560, height: 760 };
	assert.deepEqual(expandedBounds(full, area, 500), full);
	const oversized = { x: -8, y: 0, width: 2600, height: 760 };
	assert.deepEqual(expandedBounds(oversized, area, 500), oversized);
	// 用户把窗口拖到右缘外时，只向左腾挪，不把窗口继续推出屏幕。
	const offRight = { x: 2000, y: 0, width: 1250, height: 760 };
	const moved = expandedBounds(offRight, area, 500);
	assert.deepEqual(moved, { ...offRight, x: 1500, width: 1750 });
	assert.equal(moved.x + moved.width, offRight.x + offRight.width);
});

test("非零起点的第二块显示器同样以自身工作区为界", () => {
	const secondary = { x: -1920, y: 0, width: 1920, height: 1040 };
	const window = { x: -1300, y: 100, width: 1250, height: 760 };
	assert.deepEqual(expandedBounds(window, secondary, 500), { ...window, x: -1750, width: 1750 });
	assert.equal(containsBounds(secondary, window), true);
	assert.equal(containsBounds(area, window), false);
});

test("收起时保留展开期间的移动和调宽，并把原本可见的窗口留在当前显示器内", () => {
	const before = { x: 1200, y: 0, width: 1250, height: 760 };
	const after = { x: 810, y: 0, width: 1750, height: 760 };
	const record = { before, after, contained: true };
	assert.deepEqual(restoredBounds(record, { ...after, x: 830, y: 40 }, 640, areaOf), {
		x: 1220,
		y: 40,
		width: 1250,
		height: 760,
	});
	assert.deepEqual(restoredBounds(record, { ...after, width: 1950 }, 640, areaOf), { ...before, width: 1450, x: 1110 });
	assert.deepEqual(restoredBounds(record, { ...after, width: 660 }, 640, areaOf).width, 640);
	// 展开后拖到右缘的窗口，还原位置被夹回工作区。
	assert.deepEqual(restoredBounds(record, { ...after, x: 1500 }, 640, areaOf), { ...before, x: 1310 });
	assert.deepEqual(restoredBounds({ ...record, contained: false }, { ...after, x: 1500 }, 640, areaOf), {
		...before,
		x: 1890,
	});
});

test("分数缩放的取整偏差只按回读补偿一次，系统钳制和大幅变化保留原结果", () => {
	const target = { x: -1210, y: 40, width: 1151, height: 721 };
	assert.equal(roundingCorrection(target, { ...target }), undefined);
	assert.deepEqual(roundingCorrection(target, { ...target, width: 1152 }), { ...target, width: 1150 });
	assert.deepEqual(roundingCorrection(target, { ...target, x: -1211, width: 1153 }), {
		...target,
		x: -1209,
		width: 1149,
	});
	assert.equal(roundingCorrection(target, { ...target, width: 1100 }), undefined);
	assert.equal(roundingCorrection(target, { ...target, width: 1152, height: 1000 }), undefined);
});
