---
description: 根据最近的决策或变更，同步更新所有受影响的项目文档，防止规格漂移
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-sync-docs/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
