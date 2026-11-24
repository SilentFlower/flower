/**
 * 评论渲染 + GitLab 版本探测的统一入口
 *
 * 把 `comments/` 子目录下的纯函数集中导出,后续 Phase 2/3 调用方只需
 * `import { renderInlineComment, ... } from "./comments/index.js"` 即可。
 */

export {
	_resetVersionCacheForTests,
	detectGitlabVersion,
	type GitlabVersion,
	parseVersionString,
} from "./gitlab-version.js";
export {
	type CleanReviewInput,
	type FileChange,
	type InlineCommentInput,
	renderCleanReview,
	renderInlineComment,
	renderWalkthrough,
	type Severity,
	supportsAlertBlock,
	type WalkthroughInput,
} from "./render.js";
