import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";

export const attachmentTextLimit = 24 * 1024;
const pdfPageLimit = 24;
const workbookSheetLimit = 8;
const workbookRowsPerSheet = 64;
const workbookCellsPerRow = 24;
const cellTextLimit = 256;
const pdfTimeout = 12_000;

/** 向 PDF 文字读取器提供随包分发的字符映射和字体。 */
class AttachmentPdfAssets {
	/** 读取允许的本地解析资源。@param request PDF.js 的资源请求 @returns 资源字节 */
	async fetch({ kind, filename }) {
		const folder = kind === "cMapUrl" ? "cmaps" : kind === "standardFontDataUrl" ? "standard_fonts" : "";
		if (!folder || typeof filename !== "string" || !/^[\w-]+\.[\w-]+$/.test(filename)) {
			throw new Error("不支持的 PDF 解析资源。");
		}
		const root = import.meta.resolve("pdfjs-dist/package.json");
		return new Uint8Array(await readFile(new URL(`${folder}/${filename}`, root)));
	}
}

/** 在 Unicode 字符边界裁剪附件的文本样本。
 * @param value 文件中的原始文本
 * @param limit 最多保留的 UTF-16 代码单元数
 * @returns 有界的文本前缀
 */
export function clipAttachmentText(value, limit) {
	if (value.length <= limit) return value;
	const last = value.charCodeAt(limit - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/** 按工作表和实际单元格地址生成工作簿证据。
 * @param book 已通过大小及 ZIP 校验的 ExcelJS 工作簿
 * @param signal 当前任务的取消信号
 * @returns 有界证据及截断标记
 */
export function workbookEvidence(book, signal) {
	const lines = [];
	let length = 0;
	let truncated = book.worksheets.length > workbookSheetLimit;
	let full = false;
	function append(line) {
		if (length + line.length + 1 > attachmentTextLimit) {
			truncated = full = true;
			return;
		}
		lines.push(line);
		length += line.length + 1;
	}
	for (const sheet of book.worksheets.slice(0, workbookSheetLimit)) {
		signal?.throwIfAborted();
		if (full) break;
		append(`工作表 ${JSON.stringify(sheet.name)}（${sheet.actualRowCount} 个有值行，最末行号 ${sheet.rowCount}）`);
		let count = 0;
		sheet.eachRow((row, number) => {
			signal?.throwIfAborted();
			if (full || count >= workbookRowsPerSheet) {
				truncated = true;
				return;
			}
			count += 1;
			const cells = [];
			row.eachCell((cell) => {
				if (cells.length >= workbookCellsPerRow) {
					truncated = true;
					return;
				}
				const model = cell.value;
				const formula = model && typeof model === "object" && ("formula" in model || "sharedFormula" in model);
				const cached = formula ? cell.result : model;
				const value =
					cached instanceof Date
						? cached.toISOString()
						: formula
							? String(cached?.error ?? cached ?? "（公式无缓存值）")
							: cell.text;
				const sample = clipAttachmentText(value, cellTextLimit);
				if (sample.length < value.length) truncated = true;
				cells.push(`${cell.address}=${JSON.stringify(sample)}`);
			});
			append(`行 ${number}｜${cells.join("，")}`);
		});
	}
	return { text: lines.join("\n") || "工作簿没有可提取的工作表。", truncated };
}

/** 通过 PDF.js 的 Node 入口按实际页号提取 PDF 文字层。
 * @param bytes 已通过工作区授权和大小校验的 PDF 字节
 * @param signal 当前任务的取消信号
 * @returns 每页文字及是否还有内容未提取
 */
export async function pdfEvidence(bytes, signal) {
	signal?.throwIfAborted();
	const [{ getDocument, PDFWorker }, { WorkerMessageHandler }] = await Promise.all([
		import("pdfjs-dist/legacy/build/pdf.mjs"),
		import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
	]);
	signal?.throwIfAborted();
	const root = new URL("./", import.meta.resolve("pdfjs-dist/package.json"));
	const { port1, port2 } = new MessageChannel();
	const deadline = AbortSignal.timeout(pdfTimeout);
	const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const cancelled = Promise.withResolvers();
	const wait = (promise) => Promise.race([promise, cancelled.promise]);
	let worker;
	let loading;
	let destruction;
	const dispose = () => (destruction ??= loading?.destroy());
	const abort = () => {
		cancelled.reject(active.reason);
		void dispose()?.catch(() => {});
	};
	try {
		// PDF.js 将 Electron utility 视为非 Node。显式连接本地消息端并提供磁盘资源，避免走浏览器检测。
		WorkerMessageHandler.initializeFromPort(port2);
		worker = new PDFWorker({ port: port1 });
		port1.start();
		port2.start();
		loading = getDocument({
			data: Uint8Array.from(bytes),
			worker,
			BinaryDataFactory: AttachmentPdfAssets,
			cMapUrl: new URL("cmaps/", root).href,
			cMapPacked: true,
			standardFontDataUrl: new URL("standard_fonts/", root).href,
			disableWorkerRendering: true,
			disableFontFace: true,
			useSystemFonts: false,
			isOffscreenCanvasSupported: false,
			isImageDecoderSupported: false,
			useWorkerFetch: false,
			useWasm: false,
			maxImageSize: 0,
		});
		active.addEventListener("abort", abort, { once: true });
		const pdf = await wait(loading.promise);
		active.throwIfAborted();
		const pages = Math.min(pdfPageLimit, pdf.numPages);
		const sections = [`PDF 共 ${pdf.numPages} 页。`];
		let remaining = attachmentTextLimit - sections[0].length - 1;
		let truncated = pages < pdf.numPages;
		for (let number = 1; number <= pages && remaining > 0; number += 1) {
			active.throwIfAborted();
			const page = await wait(pdf.getPage(number));
			active.throwIfAborted();
			const reader = page.streamTextContent().getReader();
			const title = `第 ${number} 页\n`;
			remaining -= title.length + 1;
			let content = "";
			let done = false;
			try {
				while (remaining > 0) {
					const chunk = await wait(reader.read());
					active.throwIfAborted();
					if (chunk.done) {
						done = true;
						break;
					}
					for (const item of chunk.value.items) {
						const value = `${item.str}${item.hasEOL ? "\n" : " "}`;
						const sample = clipAttachmentText(value, remaining);
						content += sample;
						remaining -= sample.length;
						if (value.length > sample.length) remaining = 0;
						if (remaining === 0) break;
					}
				}
			} finally {
				try {
					if (!done && !active.aborted) await wait(reader.cancel());
				} finally {
					reader.releaseLock();
					page.cleanup();
				}
			}
			if (!done || remaining <= 0) truncated = true;
			const printed = content.trim() || "（无可提取文本）";
			remaining += content.length - printed.length;
			sections.push(`${title}${printed}`);
			if (!done) break;
		}
		return { text: sections.join("\n"), truncated };
	} catch (error) {
		signal?.throwIfAborted();
		if (deadline.aborted) throw new Error("PDF 文字提取超时。");
		if (error?.name === "PasswordException") throw new Error("PDF 需要密码，无法读取附件文字。");
		throw error;
	} finally {
		active.removeEventListener("abort", abort);
		try {
			await dispose();
		} finally {
			worker?.destroy();
			port1.close();
			port2.close();
		}
	}
}
