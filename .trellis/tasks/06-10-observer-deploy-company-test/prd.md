# observer company 测试线打包部署(集成 devop-infra-harness)

## Goal

把 flower-observer 部署到 company 测试线并集成 devop-infra-harness:镜像构建推 Harbor(192.168.27.236)、容器编排(db volume / TZ / OBSERVER_* env)、评审 CI 接流(FLOWER_TELEMETRY_URL + FLOWER_TELEMETRY_TOKEN 与 OBSERVER_INGEST_TOKEN 配对)、SIEM_INGEST_URL 指向 /v1/audit(可选)、OBSERVER_GITLAB_BASE_URL 配真实内网 GitLab;devop-infra-harness 的接入方式在规划阶段调研确认

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
