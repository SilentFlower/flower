import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWindowState, restorableBounds, savedBounds, writeWindowState } from "../workbench/window-state.mjs";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: -1707, y: 0, width: 1707, height: 1019 };

test("可见的保存外框原样恢复，副屏坐标与尺寸下限有效", () => {
	assert.deepEqual(restorableBounds({ x: 200, y: 80, width: 1400, height: 900 }, [primary]), {
		x: 200,
		y: 80,
		width: 1400,
		height: 900,
	});
	assert.deepEqual(restorableBounds({ x: -1500, y: 10, width: 300.4, height: 100 }, [primary, secondary]), {
		x: -1500,
		y: 10,
		width: 640,
		height: 560,
	});
});

test("标题栏不在任何显示器内时回落默认，尺寸不超过工作区", () => {
	// 副屏断开后，原来在副屏上的窗口不可见。
	assert.equal(restorableBounds({ x: -1500, y: 10, width: 1200, height: 800 }, [primary]), undefined);
	// 只露出不到 120 像素的标题栏，难以抓取。
	assert.equal(restorableBounds({ x: 1850, y: 10, width: 1200, height: 800 }, [primary]), undefined);
	assert.equal(restorableBounds({ x: 10, y: 1030, width: 1200, height: 800 }, [primary]), undefined);
	assert.equal(restorableBounds({ x: "1", y: 0, width: 800, height: 600 }, [primary]), undefined);
	assert.equal(restorableBounds(undefined, [primary]), undefined);
	assert.deepEqual(restorableBounds({ x: 0, y: 0, width: 3000, height: 2000 }, [primary]), {
		x: 0,
		y: 0,
		width: 1920,
		height: 1040,
	});
});

test("保存时扣除侧栏外扩，保留用户在展开期间的移动", () => {
	const expansion = {
		before: { x: 300, y: 50, width: 1250, height: 760 },
		after: { x: 300, y: 50, width: 1738, height: 760 },
		contained: true,
	};
	const areaOf = () => primary;
	assert.deepEqual(savedBounds({ x: 120, y: 60, width: 1738, height: 760 }, expansion, 640, areaOf), {
		x: 120,
		y: 60,
		width: 1250,
		height: 760,
	});
	const plain = { x: 1, y: 2, width: 900, height: 700 };
	assert.equal(savedBounds(plain, undefined, 640, areaOf), plain);
});

test("窗口状态同步原子写入，损坏文件读取为空", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "flower-window-state-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "window-state.json");
	assert.equal(readWindowState(path), undefined);
	writeWindowState(path, { x: 1, y: 2, width: 900, height: 700, maximized: true });
	assert.deepEqual(readWindowState(path), { x: 1, y: 2, width: 900, height: 700, maximized: true });
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).maximized, true);
	await writeFile(path, "{");
	assert.equal(readWindowState(path), undefined);
});
