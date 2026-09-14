---
name: agora-next-task
description: Locate and prepare the next ready Agora task using dependency order and the EPCC-V workflow.
---

# Select the next Agora task

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications.

1. Check for unrelated or unfinished working-tree changes and preserve them.
2. Use `summary` and recheck its `cascadeCandidates` against the canonical index before idempotently cascading eligible tasks, updating timestamps and querying again. Before selecting work in Phase N, verify from phase metadata that Phase N-1's `integration_test` task is `done`; stop if this cross-phase gate is not satisfied. Then select the first `ready` task in `current_phase`.
3. Verify all selected-task dependencies. Report the task and relevant standing decisions.
4. Wait for the user's approval before setting `in_progress`.
5. After approval, follow Explore and Plan from `AGENTS.md`: quote required specification text and present a plan appropriate to the task's actual design, code, validation, or exit deliverables. Follow the task-type rules in [task tracking maintenance](../../../docs/task-tracking.md); obtain missing plan approval before implementation and do not repeat an approval already given for the same scope.
