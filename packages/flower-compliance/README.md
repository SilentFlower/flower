# @flower-ai/flower-compliance

合规拦截扩展(纯策略包):只做"判定 + 拦截"。

> 0.2.0 起审计上报(SIEM)已收编进 `@flower-ai/flower-telemetry` 的 `siemSink`
> (payload 兼容,`SIEM_INGEST_URL` / `DEBUG_AUDIT` 语义不变);本包不再发任何 HTTP。

## 提供的能力

### 合规拦截(按模式启用)

| 模式 | 启用场景 | 拦截规则 |
|------|----------|----------|
| `ci-readonly` | code-reviewer 在 CI 内运行 | 禁 write / edit;bash 限白名单(git/grep/find/ls/cat/head/tail/wc/file/sed/awk 等),命令链按 `;` `&&` `\|\|` `\|` `&` 拆段逐段校验 |
| `production-readonly` | ops-bot 线上 | 工具本身已只读,本包当前不注册任何 handler |

### onBlock 回调(拦截事件外送)

拦截发生时回调 `onBlock(BlockEvent)`,由产品层接线到观测侧
(code-reviewer 接 telemetry 的 `recordSecurityEvent` → trace `security_block` outcome + SIEM `tool_blocked`)。
回调抛错不影响拦截结论;两包互不依赖,字段映射在产品层完成。

## 用法

```typescript
import { registerCompliance } from "@flower-ai/flower-compliance";

export default function (pi: ExtensionAPI) {
	// code-reviewer 这样用(onBlock 接 telemetry,注册顺序:telemetry → compliance → tools):
	registerCompliance(pi, {
		mode: "ci-readonly",
		product: "code-reviewer",
		onBlock: (event) => {
			/* 接 telemetry recordSecurityEvent */
		},
	});

	// ops-bot 这样用(当前为 no-op,保留模式位):
	// registerCompliance(pi, { mode: "production-readonly", product: "ops-bot" });
}
```

## 环境变量

本包不再读取任何环境变量(原 `SIEM_INGEST_URL` / `DEBUG_AUDIT` 移至 flower-telemetry,语义不变)。

## TODO

- 增加更细粒度的工具白名单(可配置)
- 增加用户级别的限流(防止单用户滥用 LLM 配额)
- 增加敏感词扫描(检测 LLM 输出里的不当内容)
