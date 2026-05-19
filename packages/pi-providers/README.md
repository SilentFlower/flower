# @flower-ai/pi-providers

自定义 LLM provider 统一注册扩展。把自部署 / 内部 / 第三方代理的 LLM 网关接入
[pi-coding-agent](https://github.com/earendil-works/pi-mono) 与 [pi-agent-core](https://github.com/earendil-works/pi-mono)。

## 职责

- 集中管理 LLM 网关的 baseUrl、token、模型清单
- 为不同产品注入 `X-App-Source` header,便于网关侧审计 / 计费
- 提供默认模型选择策略

## 用法

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompanyProviders } from "@flower-ai/pi-providers";

export default function (pi: ExtensionAPI) {
  registerCompanyProviders(pi, { appSource: "code-reviewer" });
}
```

## 环境变量

| 变量 | 必填 | 含义 |
|------|:----:|------|
| `COMPANY_LLM_BASE_URL` | ✓ | LLM 网关 baseUrl(可以是自部署 vLLM / 内部 AI Gateway / OpenAI 代理 等任意 OpenAI 兼容端点) |
| `COMPANY_AI_TOKEN` | ✓ | API token |

> 环境变量名沿用 `COMPANY_` 前缀只是命名习惯,实际可以指向任何 LLM 后端。

## TODO

- 模型清单(`COMPANY_MODELS`)中的 id / 上下文窗口 / 计费数据为占位值,
  接入实际网关时需要替换为真实值
- 如果网关支持 OAuth/SSO,需要补 `oauth` 配置
- 如果网关有非标鉴权头(非 `Authorization: Bearer`),需要调整 `authHeader`
