/**
 * 会话提醒状态：本次运行期间的完成未读与失败未读。只保存在内存，重启后不保留。
 * @returns {{terminal(session: string, status: string, viewing: boolean): string | undefined, clear(session: string): boolean, indicator(session: string, approval: boolean, busy: boolean): string | undefined}} 状态接口
 */
export function createAttention() {
	const marks = new Map();
	return {
		/**
		 * 记录终态。用户主动取消或拒绝授权不提醒；正在前台查看该会话时不标未读。
		 * @param {string} session 会话 ID
		 * @param {string} status 终态
		 * @param {boolean} viewing 用户是否正在前台查看该会话
		 * @returns {"done" | "failed" | undefined} 需要提醒的类别
		 */
		terminal(session, status, viewing) {
			const mark =
				status === "succeeded" ? "done" : status === "failed" || status === "interrupted" ? "failed" : undefined;
			if (mark && !viewing) marks.set(session, mark);
			return mark;
		},
		/** 用户查看会话后清除未读。@param {string} session 会话 ID @returns {boolean} 是否清除了标记 */
		clear(session) {
			return marks.delete(session);
		},
		/**
		 * 侧栏只显示一个状态：待批准优先于运行中，其次是未读标记。
		 * @param {string} session 会话 ID
		 * @param {boolean} approval 是否有待批准写入
		 * @param {boolean} busy 是否有运行或排队任务
		 * @returns {"approval" | "running" | "done" | "failed" | undefined} 状态
		 */
		indicator(session, approval, busy) {
			if (approval) return "approval";
			if (busy) return "running";
			return marks.get(session);
		},
	};
}
