---
description: 当前 Phase 的集成测试 — 生成、审查完整性、补全缺口、运行回归
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-test-phase/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
