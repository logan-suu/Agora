---
name: agora-next-task
description: Locate and prepare the next ready Agora task using dependency order and the EPCC-V workflow.
---

# Select the next Agora task

1. Check for unrelated or unfinished working-tree changes and preserve them.
2. Read `docs/task-status.json`, idempotently cascade eligible `pending` tasks to `ready`, and select the first `ready` task in `current_phase`.
3. Verify all dependencies and the cross-phase gate. Report the task and relevant standing decisions.
4. Wait for the user's approval before setting `in_progress`.
5. After approval, follow Explore and Plan from `AGENTS.md`: quote required specification text and present a file/interface/test plan. Wait for separate plan approval before Code.
