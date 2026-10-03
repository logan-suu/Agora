---
name: agora-test-unit
description: Run and analyze Agora unit tests for a task or path together with type and lint checks, without silently weakening tests.
---

# Run Agora unit checks

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications.

Resolve a user-specified task or test path from `docs/task-status.json`. With no argument, select the current `in_progress` task, otherwise the most recently updated `done` task; if neither exists, list the current phase's choices and stop. If the selected task has `test_file: null` and no path was supplied, report that no test file is configured, list current-phase tasks that do have one, and stop.

Run typecheck, lint, and the resolved test target, expanding to affected unit consumers under [TEST-STRATEGY](../../../docs/testing-strategy.md). Do not automatically add full `pnpm test` to a focused unit request. Report exactly what ran; a focused result does not satisfy the complete PR baseline, integration/G5, or cumulative full gate. Identify any additional delivery gates and full-regression triggers from the actual change. Reuse evidence only when its relevant inputs and environment remain verified; preserve assertions and real dependencies. Report counts and coverage against the task's documented contract. On failure, identify whether production behavior, the test, or the environment is at fault using evidence and R11. Do not change code or assertions unless the user explicitly requests a fix.
