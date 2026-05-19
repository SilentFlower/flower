# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

- [x] Fill guidelines for @flower-ai/flower-code-reviewer
- [x] Fill guidelines for @flower-ai/flower-compliance
- [x] Fill guidelines for @flower-ai/flower-ops-bot
- [x] Fill guidelines for @flower-ai/flower-providers
- [x] Fill guidelines for @flower-ai/flower-tools-arms
- [x] Fill guidelines for @flower-ai/flower-tools-common
- [x] Fill guidelines for @flower-ai/flower-tools-gitlab
- [x] Add code examples

---

## Spec files to populate

### Package: @flower-ai/flower-code-reviewer (`spec/flower-code-reviewer/`)

- Frontend guidelines: `.trellis/spec/flower-code-reviewer/frontend/`

### Package: @flower-ai/flower-compliance (`spec/flower-compliance/`)

- Backend guidelines: `.trellis/spec/flower-compliance/backend/`

- Frontend guidelines: `.trellis/spec/flower-compliance/frontend/`

### Package: @flower-ai/flower-ops-bot (`spec/flower-ops-bot/`)

- Backend guidelines: `.trellis/spec/flower-ops-bot/backend/`

- Frontend guidelines: `.trellis/spec/flower-ops-bot/frontend/`

### Package: @flower-ai/flower-providers (`spec/flower-providers/`)

- Backend guidelines: `.trellis/spec/flower-providers/backend/`

- Frontend guidelines: `.trellis/spec/flower-providers/frontend/`

### Package: @flower-ai/flower-tools-arms (`spec/flower-tools-arms/`)

- Backend guidelines: `.trellis/spec/flower-tools-arms/backend/`

- Frontend guidelines: `.trellis/spec/flower-tools-arms/frontend/`

### Package: @flower-ai/flower-tools-common (`spec/flower-tools-common/`)

- Backend guidelines: `.trellis/spec/flower-tools-common/backend/`

- Frontend guidelines: `.trellis/spec/flower-tools-common/frontend/`

### Package: @flower-ai/flower-tools-gitlab (`spec/flower-tools-gitlab/`)

- Backend guidelines: `.trellis/spec/flower-tools-gitlab/backend/`

- Frontend guidelines: `.trellis/spec/flower-tools-gitlab/frontend/`


### Thinking guides (already populated)

`.trellis/spec/guides/` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python3 ./.trellis/scripts/task.py finish
python3 ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
