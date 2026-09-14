---
description: 重试当前失败或中断的任务，从断点恢复开发流程
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-retry-task/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
