const examples = [
	{
		id: "orders",
		directory: "经营样例",
		file: "orders.csv",
		title: "季度订单",
		digest: "bead58d14bf87d88d691faed38c3c2807ff3eb0cb51ef88f71dde9d406e905fa",
	},
	{
		id: "refunds",
		directory: "经营样例",
		file: "refunds.csv",
		title: "退款记录",
		digest: "4356b70d351b396cd160c4d8d1be2041e6f3599f4b4335757466163bca423d8b",
	},
	{
		id: "tickets",
		directory: "服务样例",
		file: "tickets.csv",
		title: "服务工单",
		digest: "3f64f48a74e5331fb0eb266dc6c0581063217992d368fe6a2874b8522fb42155",
	},
];
export const samples = new Map(examples.map((item) => [item.id, Object.freeze(item)]));
export const tasks = new Map([
	["summary", "按分组汇总"],
	["preview", "预览原始记录"],
]);

/** 向界面提供已知的样例选项。
 * @returns 脱敏的样例目录、文件和任务标签
 */
export function demoCatalog() {
	return {
		samples: examples.map(({ id, directory, file, title }) => ({ id, directory, file, title })),
		tasks: [...tasks].map(([id, title]) => ({ id, title })),
	};
}
