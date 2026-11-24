import type { Agent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type {
	Api,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	TranscriptContext,
} from "@earendil-works/pi-ai";

/** 由宿主核验并绑定到访问入口的主体。 */
export interface RuntimeSubject {
	readonly kind: "service" | "employee";
	readonly id: string;
}

/** 会话持久化与调度使用的分区键。 */
export interface SessionScope {
	readonly host: string;
	readonly subject: RuntimeSubject;
	readonly sessionId: string;
}

/** 宿主范围内的资料引用，正文与凭据由宿主按次读取。 */
export interface RuntimeAttachment {
	readonly id: string;
	readonly name: string;
}

/** 宿主同一条模型路径也负责接收上下文摘要请求。 */
export type RuntimeModelStream = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions & { readonly purpose?: "summary" },
) => ReturnType<StreamFn>;

/** 宿主为一个会话提供的当前权限与 pi 运行能力。 */
export type SessionGrant = {
	readonly workspaceId: string;
	/**
	 * 为工具调用生成简短的展示目标，例如文件名。异常或非字符串结果视为无目标。
	 * @param toolName 工具名
	 * @param args 模型给出的工具参数
	 * @returns 展示目标，最长保留 120 字符
	 */
	describeTool?(toolName: string, args: unknown): string | undefined;
} & (
	| {
			readonly model: Model<Api>;
			readonly streamFn: RuntimeModelStream;
			readonly tools: readonly AgentTool[];
			/** 执行时读取本次已授权的附件。@param refs 有序资料引用 @param signal 本轮取消信号 @returns 模型可读内容 */
			readAttachments?(refs: readonly RuntimeAttachment[], signal: AbortSignal): Promise<(TextContent | ImageContent)[]>;
			readonly systemPrompt?: string;
	  }
	| {
			/** 队首复核通过后按次装配 SDK 会话。 */
			createExecution(context: RuntimeExecutionContext): RuntimeExecution | Promise<RuntimeExecution>;
	  }
);

/** 共享核心为宿主执行器提供的已授权运行上下文。 */
export interface RuntimeExecutionContext {
	readonly messages: readonly AgentMessage[];
	readonly attachments?: readonly RuntimeAttachment[];
	readonly providerSessionId: string;
	readonly signal: AbortSignal;
}

/** 宿主 SDK 适配。调度、取消与持久化由共享核心负责。 */
export interface RuntimeExecution {
	/** 提交本次提示。 */
	prompt(input: string): Promise<void>;
	/** 订阅底层 pi 事件并返回注销函数。 */
	subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void;
	/** 请求停止当前执行。 */
	abort(): void | Promise<void>;
	/** 等待 SDK 执行和监听器收敛。 */
	waitForIdle(): Promise<void>;
	/** 取得本次运行收敛后的消息。 */
	getMessages(): readonly AgentMessage[];
	/**
	 * 把用户插话排入当前运行，在当前一步结束后送入模型。宿主不支持时缺省。
	 * @param input 插话原文
	 * @param attachments 插话附带的资料引用
	 * @returns 已排入执行体后兑现
	 */
	steer?(input: string, attachments?: readonly RuntimeAttachment[]): Promise<void>;
	/** 释放本轮 SDK 生命周期资源。 */
	dispose?(): void | Promise<void>;
}

/** 从接收到最终处置的请求状态。 */
export type RequestStatus = "queued" | "running" | "cancelling" | TerminalStatus;

/** 请求终态，重启仅恢复已保存的记录。 */
export type TerminalStatus = "succeeded" | "failed" | "denied" | "cancelled" | "interrupted";

/** 工具返回给宿主的文本与调用标识。 */
export interface ToolResult {
	toolName: string;
	toolCallId: string;
	text: string[];
	isError: boolean;
}

/** 一次工具调用的展示摘要。不保存工具参数原文，避免大参数进入会话记录。 */
export interface ToolStep {
	toolCallId: string;
	toolName: string;
	/** 宿主给出的展示目标，例如文件名。 */
	target?: string;
	/** 开始时刻，毫秒时间戳。 */
	startedAt: number;
	/** 结束时刻，未收到工具结果时缺省。 */
	endedAt?: number;
	isError?: boolean;
}

/** 已送达当前运行的用户插话。 */
export interface SteerRecord {
	/** 宿主提交插话时给出的标识，用于对应送达事件。 */
	steerId: string;
	input: string;
	attachments?: readonly RuntimeAttachment[];
	/** 送达时刻，毫秒时间戳。 */
	at: number;
	/** 送达时回复正文的长度，宿主据此把插话显示在回复的对应位置。 */
	textOffset: number;
}

/** 可展示的稳定错误分类，独立于 pi 和宿主异常细节。 */
export type FailureCode = "invalid-input" | "denied" | "not-found" | "storage" | "agent-error";

/** 展示给宿主的错误类别与说明。 */
export interface RuntimeFailure {
	code: FailureCode;
	message: string;
}

/** 持久化请求，以及截至当前已提交的输出。 */
export interface RequestRecord {
	requestId: string;
	workspaceId: string;
	input: string;
	attachments?: readonly RuntimeAttachment[];
	status: RequestStatus;
	runId?: string;
	/** 原生 pi 成功请求的用户消息在完整 messages 中的位置。 */
	userMessageIndex?: number;
	text: string;
	toolResults: ToolResult[];
	/** 按开始顺序记录的工具步骤，早期记录缺省。 */
	steps?: ToolStep[];
	/** 开始运行的时刻，毫秒时间戳。 */
	startedAt?: number;
	/** 进入终态的时刻，毫秒时间戳。重启时补记的中断不写入。 */
	endedAt?: number;
	/** 按送达顺序记录的插话，早期记录与没有插话的请求缺省。 */
	steers?: SteerRecord[];
	failure?: RuntimeFailure;
}

/** 未完成请求在归档中附带的工具回执。只在模型投影时转成会话数据。 */
interface ArchivedToolReceipt {
	role: "flowerToolReceipt";
	requestId: string;
	timestamp: number;
	content: string;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		flowerToolReceipt: ArchivedToolReceipt;
	}
}

/** 由宿主保管的外部操作记录。 */
export interface ExternalOperation {
	id: string;
	status: "confirmed" | "needs-verification";
	result?: string;
}

/** 模型续接检查点，through 是已归纳的非系统模型消息数。 */
export interface ContextCheckpoint {
	through: number;
	summary: string;
	/** 产生方式：运行中超出窗口自动压缩，或用户手动压缩；早期检查点没有此字段。 */
	trigger?: "auto" | "manual";
}

/** 当前授权模型对会话的本地占用估算。 */
export interface RuntimeContextUsage {
	tokens: number;
	limit: number;
	estimated: true;
}

/** 存储中的可恢复会话。版本号与事件序号随记录提交。 */
export interface SessionSnapshot {
	version: 1;
	/** 首条已提交请求绑定的工作区。 */
	readonly workspaceId: string;
	lastSequence: number;
	requests: RequestRecord[];
	messages: AgentMessage[];
	contextCheckpoint?: ContextCheckpoint;
	artifacts: string[];
	operations: ExternalOperation[];
}

/** 早期快照只在请求记录中保存工作区，读取时恢复会话级绑定。 */
export type StoredSessionSnapshot = Omit<SessionSnapshot, "workspaceId"> & { readonly workspaceId?: string };

/** 宿主负责按 scope 分区存储。单个分区由一个活动运行时写入。 */
export interface SessionStore {
	/**
	 * 读取一个分区的已提交记录。
	 * @param scope 已授权的会话分区
	 * @returns 会话记录，首次访问时为空
	 */
	load(scope: SessionScope): Promise<StoredSessionSnapshot | undefined>;

	/**
	 * 原子提交该分区的完整快照。
	 * @param scope 已授权的会话分区
	 * @param snapshot 待提交的会话记录
	 * @returns 提交完成后兑现的 Promise
	 */
	save(scope: SessionScope, snapshot: SessionSnapshot): Promise<void>;
}

/** 运行时向宿主发送的会话事件。 */
export type RuntimeEvent = {
	sessionId: string;
	requestId: string;
	runId?: string;
	sequence: number;
	/** 提交时刻，毫秒时间戳。 */
	at: number;
} & (
	| { type: "queued"; position: number }
	| { type: "started" }
	| { type: "cancelling" }
	| { type: "text_delta"; delta: string }
	| { type: "tool_started"; toolName: string; toolCallId: string; target?: string }
	| { type: "steered"; steerId: string }
	| ({ type: "tool_result" } & ToolResult)
	| { type: "terminal"; status: TerminalStatus; failure?: RuntimeFailure }
);

/** 宿主为运行时提供的配置。 */
export interface RuntimeOptions {
	readonly host: string;
	readonly store: SessionStore;

	/**
	 * 按当前身份和会话授权，接收请求和启动运行时分别复核。
	 * @param scope 所请求的会话分区
	 * @returns 授权能力，拒绝时为空
	 */
	authorize(scope: SessionScope): SessionGrant | undefined | Promise<SessionGrant | undefined>;
}

/** 宿主绑定主体后使用的会话端口。 */
export interface SubjectRuntime {
	/**
	 * 按接收顺序提交输入。
	 * @param sessionId 当前主体可访问的会话
	 * @param input 本次模型输入
	 * @param attachments 本次请求的资料引用
	 * @returns 已提交的请求记录
	 */
	submit(sessionId: string, input: string, attachments?: readonly RuntimeAttachment[]): Promise<RequestRecord>;

	/**
	 * 取消队列中的请求，已开始时返回它的当前状态。
	 * @param sessionId 当前主体可访问的会话
	 * @param requestId 入队时分配的请求 ID
	 * @returns 请求的最新记录
	 */
	cancelQueued(sessionId: string, requestId: string): Promise<RequestRecord>;

	/**
	 * 对当前运行发起取消。
	 * @param sessionId 当前主体可访问的会话
	 * @param runId 运行开始时分配的运行 ID
	 * @returns 取消中的记录，已结束时返回终态
	 */
	cancelRunning(sessionId: string, runId: string): Promise<RequestRecord>;

	/**
	 * 查看已持久化的会话。进程重启后恢复历史和中断状态。
	 * @param sessionId 当前主体可访问的会话
	 * @returns 当前会话快照
	 */
	getSession(sessionId: string): Promise<SessionSnapshot>;

	/** 估算会话当前模型可见的历史。@param sessionId 本主体会话 @returns 当前窗口与估算，缺少模型时为空 */
	getContextUsage(sessionId: string): Promise<RuntimeContextUsage | undefined>;

	/**
	 * 向运行中的请求插话。送达后请求记录追加插话并发出 steered 事件；运行在送达前结束时不记录。
	 * @param sessionId 当前主体可访问的会话
	 * @param runId 运行开始时分配的运行 ID
	 * @param steerId 宿主为本次插话分配的标识
	 * @param input 插话原文
	 * @param attachments 插话附带的资料引用
	 * @returns 已排入当前运行后兑现；运行已结束或执行体不支持插话时拒绝
	 */
	steer(
		sessionId: string,
		runId: string,
		steerId: string,
		input: string,
		attachments?: readonly RuntimeAttachment[],
	): Promise<void>;

	/**
	 * 在会话空闲时把迄今的对话归纳为检查点摘要。压缩期间不调度新请求，完成后照常调度。
	 * @param sessionId 当前主体可访问的会话
	 * @param signal 调用方的取消信号
	 * @returns 写入了新检查点时为 true，没有可归纳的新对话时为 false；失败、取消时拒绝且检查点不变
	 */
	compact(sessionId: string, signal?: AbortSignal): Promise<boolean>;
}

/** 用于宿主绑定已核验主体的共享运行时。 */
export interface AgentRuntime {
	/**
	 * 绑定主体，事件发送给该主体的请求观察者。
	 * @param subject 已由宿主核验的主体
	 * @param onEvent 接收该绑定所提交请求的事件
	 * @returns 已隔离的会话端口
	 */
	bindSubject(subject: RuntimeSubject, onEvent: (event: RuntimeEvent) => void): SubjectRuntime;
}
