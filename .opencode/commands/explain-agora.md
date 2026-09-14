---
description: 结合 Agora 项目文档解释特定的代码片段、架构决策或设计概念（溯源到文档原文）
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-explain/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
