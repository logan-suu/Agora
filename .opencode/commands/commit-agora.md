---
description: 质量门禁检查 → 功能分支提交 → 创建 PR 到 dev-1.0.0（合并后由 /pr-merge-agora 收尾）
agent: build
---

# Agora compatibility entry

Read and follow the canonical workflow at `.agents/skills/agora-commit/SKILL.md` for this command, using the user’s task ID, PR, path, and existing authorization. This compatibility entry does not maintain a second workflow.

Start task discovery with `node scripts/task-status.mjs summary`; load only the relevant task, phase, decisions, and required history pages. Current state comes only from `docs/task-status.json`; full evidence is linked through `docs/task-history/<taskId>.md`.
