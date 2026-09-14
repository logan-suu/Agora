---
description: 累进全量集成测试 — Phase 0→N 全部集成测试 + 跨 Phase 联调 + 单元测试全量回归
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-test-integration/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
