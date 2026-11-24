/**
 * 根据 MR 修改的文件类型自动选 skill
 */

import { gitlabClient } from "@flower-ai/flower-tools-gitlab";

/**
 * 选 skill 的策略:
 *
 * 1. 如果有任何文件路径命中安全敏感模式(auth / login / crypto / secret)→ security
 * 2. 否则,如果大多数文件是后端语言(.go / .java / .py / 后端 .ts)→ backend
 * 3. 否则,如果大多数文件是前端(.tsx / .vue / .css / .html)→ frontend
 * 4. 否则 → general
 */
export async function pickSkill(): Promise<string> {
	const projectId = process.env.CI_PROJECT_ID;
	const mrIidRaw = process.env.CI_MERGE_REQUEST_IID;
	if (!projectId || !mrIidRaw) {
		return "general";
	}
	const mrIid = Number.parseInt(mrIidRaw, 10);

	let files: string[];
	try {
		files = await gitlabClient().getMrFiles(projectId, mrIid);
	} catch {
		return "general";
	}

	if (files.some((f) => /auth|login|crypto|secret|password|token/i.test(f))) {
		return "security";
	}

	const backend = files.filter((f) => /\.(go|java|py|rb|rs|cs)$/.test(f)).length;
	const frontend = files.filter((f) => /\.(tsx?|jsx?|vue|css|html|scss)$/.test(f)).length;

	if (backend > frontend && backend > 0) return "backend";
	if (frontend > 0) return "frontend";
	return "general";
}
