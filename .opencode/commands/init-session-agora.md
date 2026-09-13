---
description: Agora 新会话初始化 — 读取规约、定位进度、锁定规格上下文、等待确认后开工
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-init-session/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
