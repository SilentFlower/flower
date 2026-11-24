const wordNamespaces = new Set([
	"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	"http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const nonBodyContent = new Set(["del", "moveFrom", "drawing", "pict", "object"]);
const wordXmlLimit = 4 * 1024 * 1024;
const paragraphLimit = 200;
const wordTextLimit = 64 * 1024;
const tableRowLimit = 100;
const tableColumnLimit = 32;

async function readWordXml(bytes, signal) {
	const { default: yauzl } = await import("yauzl");
	const archive = await new Promise((resolve, reject) => {
		yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, opened) =>
			error ? reject(error) : resolve(opened),
		);
	});
	try {
		if (archive.entryCount > 2000) throw new Error("DOCX 文件超出安全解析范围。");
		const entry = await new Promise((resolve, reject) => {
			let body;
			archive.on("error", reject);
			archive.on("end", () => (body ? resolve(body) : reject(new Error("DOCX 缺少 Word 正文。"))));
			archive.on("entry", (item) => {
				if (signal?.aborted) return reject(signal.reason);
				if (item.fileName === "word/document.xml") {
					if (body || item.uncompressedSize > wordXmlLimit) {
						return reject(new Error("DOCX 正文超出安全解析范围或存在重复项。"));
					}
					body = item;
				}
				archive.readEntry();
			});
			archive.readEntry();
		});
		signal?.throwIfAborted();
		const stream = await new Promise((resolve, reject) => {
			archive.openReadStream(entry, (error, opened) => (error ? reject(error) : resolve(opened)));
		});
		let length = 0;
		const chunks = [];
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			length += chunk.length;
			if (length > wordXmlLimit) throw new Error("DOCX 正文超过解压上限。");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, length);
	} finally {
		archive.close();
	}
}

function wordParagraphs(xml, SaxesParser) {
	const parser = new SaxesParser({ xmlns: true });
	const paragraphs = [];
	let namespace;
	let foundBody = false;
	let depth = 0;
	let bodyDepth = 0;
	let paragraphDepth = 0;
	let textDepth = 0;
	let ignoredDepth = 0;
	let paragraph = "";
	let length = 0;
	let truncated = false;

	function append(value) {
		if (truncated) return;
		if (paragraphs.length === paragraphLimit) {
			truncated = Boolean(value.trim());
			return;
		}
		const remaining = wordTextLimit - length - paragraph.length;
		if (value.length <= remaining) {
			paragraph += value;
			return;
		}
		// 返回的正文在 Unicode 字符边界收尾。
		const last = value.charCodeAt(remaining - 1);
		const end = last >= 0xd800 && last <= 0xdbff ? remaining - 1 : remaining;
		paragraph += value.slice(0, end);
		truncated = true;
	}

	parser.on("doctype", () => {
		throw new Error("DOCX 正文不支持文档类型声明。");
	});
	parser.on("opentag", (tag) => {
		depth += 1;
		if (depth > 256) throw new Error("DOCX 正文层级超过解析上限。");
		if (depth === 1) {
			if (tag.local !== "document" || !wordNamespaces.has(tag.uri)) throw new Error("DOCX 正文格式无效。");
			namespace = tag.uri;
		}
		if (tag.uri !== namespace || ignoredDepth) return;
		if (depth === 2 && tag.local === "body") {
			foundBody = true;
			bodyDepth = depth;
			return;
		}
		if (!bodyDepth) return;
		if (nonBodyContent.has(tag.local)) {
			ignoredDepth = depth;
			return;
		}
		if (!paragraphDepth && tag.local === "p") paragraphDepth = depth;
		if (!paragraphDepth) return;
		if (tag.local === "t") textDepth = depth;
		if (tag.local === "tab") append("\t");
		if (tag.local === "br" || tag.local === "cr") append("\n");
	});
	function appendText(value) {
		if (textDepth && !ignoredDepth) append(value);
	}
	parser.on("text", appendText);
	parser.on("cdata", appendText);
	parser.on("closetag", () => {
		if (depth === ignoredDepth) ignoredDepth = 0;
		if (depth === textDepth) textDepth = 0;
		if (depth === paragraphDepth) {
			if (paragraph.trim()) {
				paragraphs.push(paragraph);
				length += paragraph.length;
			}
			paragraph = "";
			paragraphDepth = 0;
		}
		if (depth === bodyDepth) bodyDepth = 0;
		depth -= 1;
	});
	parser.write(xml).close();
	if (!foundBody) throw new Error("DOCX 缺少 Word 正文。");
	return truncated ? { kind: "document", paragraphs, truncated: true } : { kind: "document", paragraphs };
}

/** 从 DOCX 的 Word 主文档提取有界正文。
 * @param bytes 已通过工作区授权和压缩大小校验的文档
 * @param signal 当前会话的取消信号
 * @returns 正文段落和可选截断标记
 */
export async function previewDocx(bytes, signal) {
	const [xml, { SaxesParser }] = await Promise.all([readWordXml(bytes, signal), import("saxes")]);
	signal?.throwIfAborted();
	return wordParagraphs(decodeDocumentText(xml, false, true), SaxesParser);
}

function decodeDocumentText(bytes, truncated, fatal = false) {
	const bom = bytes[0] * 256 + bytes[1];
	const encoding = bom === 0xfffe ? "utf-16le" : bom === 0xfeff ? "utf-16be" : "utf-8";
	return new TextDecoder(encoding, { fatal }).decode(bytes, { stream: truncated });
}

/** 将分隔文本的完整记录转换为有界表格。
 * @param bytes 源文件中已授权读取的字节
 * @param delimiter 逗号或制表符
 * @param sourceTruncated 是否只读到了文件开头
 * @returns 表格行和可选截断标记
 */
export function previewDelimitedTable(bytes, delimiter, sourceTruncated) {
	const input = decodeDocumentText(bytes, sourceTruncated);
	const rows = [];
	let row = [];
	let field = "";
	let state = "plain";
	let truncated = sourceTruncated;

	function finishField() {
		if (row.length < tableColumnLimit) row.push(field);
		else truncated = true;
		field = "";
		state = "plain";
	}

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (state === "quoted") {
			if (char !== '"') field += char;
			else if (input[i + 1] === '"') {
				field += char;
				i += 1;
			} else state = "closed";
			continue;
		}
		if (char === delimiter) {
			finishField();
		} else if (char === "\r" || char === "\n") {
			finishField();
			rows.push(row);
			row = [];
			if (char === "\r" && input[i + 1] === "\n") i += 1;
			if (rows.length === tableRowLimit && i + 1 < input.length) {
				return { kind: "table", rows, truncated: true };
			}
		} else if (state === "closed") {
			if (char !== " " && char !== "\t") throw new Error("表格列的引号格式无效。");
		} else if (char === '"' && field.length === 0) {
			state = "quoted";
		} else {
			field += char;
		}
	}
	// 字节上限可能截在引号或换行中间，只展示已结束的记录。
	if (!sourceTruncated) {
		if (state === "quoted") throw new Error("表格列的引号未闭合。");
		if (row.length || field.length || state === "closed") {
			finishField();
			rows.push(row);
		}
	}
	return truncated ? { kind: "table", rows, truncated: true } : { kind: "table", rows };
}
