---
description: PR 合并后的任务收尾 — 同步 dev-1.0.0、标记任务 done、级联翻转与阶段收尾检查
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-pr-merge/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
