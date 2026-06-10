# trellis 多包配置与 spec 补全(flower-telemetry / flower-observer)

## Goal

flower-telemetry 注册进 .trellis/config.yaml packages(flower-observer 已注册);为两个包新建 .trellis/spec/<pkg>/ 规范目录(index.md + 分层指南),沉淀:node:sqlite WAL/upsert 实测范式、httpSink 线协议服务端实现要点(幂等/禁3xx/坏行容忍)、跨通道计数去重模式、telemetry sink 实现约定(fail-open/不抛错)、tsc --build 指定包构建避 TS5083 技巧

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
