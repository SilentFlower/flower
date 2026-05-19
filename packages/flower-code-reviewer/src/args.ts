/**
 * CLI 参数解析
 */

/**
 * 已解析的参数
 */
export interface CliArgs {
	/** MR IID(可选,默认从 CI_MERGE_REQUEST_IID 环境变量读) */
	mrIid: number | undefined;
	/** 强制使用某个 skill,不自动选择 */
	skill: string | undefined;
	/** 试跑模式:不真的发评论 */
	dryRun: boolean;
}

/**
 * 解析命令行参数
 *
 * @param argv - process.argv.slice(2) 之后的数组
 */
export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { mrIid: undefined, skill: undefined, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--mr-iid": {
				const value = argv[++i];
				if (!value) throw new Error("--mr-iid 需要传值");
				const parsed = Number.parseInt(value, 10);
				if (Number.isNaN(parsed)) throw new Error(`--mr-iid 必须是整数: ${value}`);
				args.mrIid = parsed;
				break;
			}
			case "--skill": {
				const value = argv[++i];
				if (!value) throw new Error("--skill 需要传值");
				args.skill = value;
				break;
			}
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`未知参数: ${arg}`);
		}
	}
	return args;
}

function printHelp(): void {
	console.log(`flower-review — GitLab MR 代码评审 agent

用法:
  flower-review [选项]

选项:
  --mr-iid <N>    指定 MR IID(默认读 CI_MERGE_REQUEST_IID 环境变量)
  --skill <NAME>  强制使用某个 skill(默认根据修改文件类型自动选择)
                  可选值: general / backend / frontend / security
  --dry-run       试跑模式,不实际发评论
  -h, --help      显示帮助

环境变量:
  CI_PROJECT_ID, CI_MERGE_REQUEST_IID  GitLab CI 自动注入
  GITLAB_TOKEN                         有 MR 评论权限的 token
  LLM_BASE_URL, LLM_API_KEY            LLM 网关入口
`);
}
