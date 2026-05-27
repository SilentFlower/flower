# flower-code-reviewer 详细 HTML 文档 · 技术设计

## 1. 设计边界

本任务只产出静态文档资产,不改变 `packages/flower-code-reviewer/` 的运行时代码、构建脚本或 CI 行为。

交付边界:

- 在 `docs/intro.html` 中维护增强版单文件工程手册,浏览器通过 `file://` 可直接打开。
- 不再另建 `docs/code-reviewer-detailed.html`;用户已确认当前实现载体就是 `docs/intro.html`。
- 文档内容以 `packages/flower-code-reviewer/` 的当前源码、相关 sibling package 边界、现有 Trellis spec 和既有任务沉淀为事实来源。
- 不新增外部资源依赖,不引入构建步骤、JS 框架、CDN 或自动化文档生成器。

## 2. 文档结构

`docs/intro.html` 中的 flower-code-reviewer B2.1 章节采用语义化 HTML:

- B2.1 外层 `<details id="b2-1">`: flower-code-reviewer 操作手册入口。
- S1-S12 子节 `<details id="b2-1-sN">`: 每个必备章节一个稳定锚点。
- 模块剖析、feature 卡片、附录 few-shot 等内容块沿用现有 intro.html 的 details/table/pre 风格。
- `<table>` / `<pre>` / inline `<svg>`: 承载配置表、接入示例、流程图和依赖图。

CSS 直接内联在 `<style>` 中,沿用 `intro.html` 的设计令牌、字体栈、顶部状态条、学术手稿式区块语言。允许为技术文档增加少量局部组件样式,但不能变成独立的新视觉体系。

## 3. 事实来源与溯源方式

文档中的事实必须从仓库读取,不能凭记忆填写。

主要源码来源:

- `packages/flower-code-reviewer/src/cli.ts`
- `packages/flower-code-reviewer/src/args.ts`
- `packages/flower-code-reviewer/src/run.ts`
- `packages/flower-code-reviewer/src/prompts.ts`
- `packages/flower-code-reviewer/src/skill-selector.ts`
- `packages/flower-code-reviewer/src/extension.ts`
- `packages/flower-code-reviewer/src/observability.ts`
- `packages/flower-code-reviewer/src/review-trace.ts`
- `packages/flower-code-reviewer/src/comments/*.ts`
- `packages/flower-code-reviewer/src/reviewer-self-tools.ts`
- `packages/flower-code-reviewer/Dockerfile`

跨包事实来源:

- `packages/flower-providers/`: provider 注册、env 到 CLI 参数翻译、默认模型相关事实。
- `packages/flower-tools-gitlab/`: GitLab REST tools、评论工具、safe read、severity marker。
- `packages/flower-tools-common/`: quick action sanitize、共享工具边界。
- `packages/flower-compliance/`: ci-readonly、审计、bash 白名单边界。

关键术语首次出现时写成「术语(`相对路径:函数名/类型名`)」,避免写死行号导致源码漂移。例如 `scanForBlockers` 写作 `scanForBlockers`(`packages/flower-code-reviewer/src/run.ts`)。

## 4. 内容组织策略

S1-S12 直接对应 PRD 的必备 sections,不再扩展新的一级主题。

- S1-S3 先服务接入方:定位、触发链路、包依赖。
- S4-S7 服务维护者:模块职责、prompt 工作流、已 ship features、错误处理。
- S8-S10 服务落地接入:env、GitLab CI、容器与部署。
- S11-S12 服务后续 contributor:已知局限、few-shot 附录。

大段源码不直接复制,除非 PRD 明确要求字符级一致的 prompt few-shot。其他位置用摘要 + 源码路径指针,保持文档可维护。

## 5. 图示设计

图示全部内联,优先使用 CSS 网格和少量 SVG:

- 触发链路图:横向流程 SVG,标出容器内 / 容器外边界、LLM 网关、GitLab API、compliance 和 observability。
- 包依赖图:中心节点 `flower-code-reviewer`,周围节点为 sibling packages 和 pi-coding-agent,用线条标明依赖方向。
- exit code / fail-open:可用小型流程图或表格表达,避免复杂交互。

图示文字必须可复制、可读,不能只依赖颜色表达语义。

## 6. 兼容性与维护性

- HTML 必须无外部资源依赖:不得出现 `<script src=...>`、`<link rel="stylesheet" href=...>`、字体 CDN 或 mermaid CDN;普通 `<a href="https://...">` 引用链接和代码示例 URL 允许存在。
- 使用 ASCII 标点为主,保留中文正文和源码标识符。
- 代码块中的示例必须与源码或 PRD 明确要求一致。
- `intro.html` 移动后不改内容,通过 `git diff --find-renames -- docs/intro.html intro.html` 或 `git diff -M --stat` 验证 rename。

## 7. 验证设计

最小验证组合:

- `git diff -M --stat` 确认根目录 `intro.html` 已迁移到 `docs/intro.html`。
- `rg -n "<script\\s+src|<link\\s+[^>]*stylesheet|@import|mermaid|cdn" docs/intro.html` 确认无外部资源依赖。
- `rg -n "id=\"b2-1-s(1|2|3|4|5|6|7|8|9|10|11|12)\"" docs/intro.html` 确认章节完整。
- 用浏览器或轻量静态检查打开 `docs/intro.html`。
- 对照源码抽查 env、exit code、prompt few-shot、工具名称和模块职责。

## 8. 回滚方式

本任务只改文档资产。若交付不符合预期:

- 回退 `docs/intro.html` 中 B2.1 的新增/修订内容。
- 如需恢复旧位置,用 `git mv docs/intro.html intro.html`。
- 保留 Trellis 任务产物以便继续修订规划。
