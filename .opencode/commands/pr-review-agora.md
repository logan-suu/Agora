---
description: 对当前 PR 做架构预审（红线/常驻决策/投影纪律）+ 逐条处理 PR 评论，输出风险清单与合并建议
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-pr-review/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
