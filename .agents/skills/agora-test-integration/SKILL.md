---
name: agora-test-integration
description: Run Agora's cumulative integration and regression suite from Phase 0 through the current phase, including cross-phase data-flow coverage.
---

# Run cumulative Agora integration checks

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Read `current_phase` from the `summary` query and query each relevant `phase <id>`. Audit `tests/integration/cross-phase` against implemented phase-to-phase data flows; present a plan and wait for approval before adding missing tests. Run each phase integration suite from Phase 0 through the current phase, the cross-phase suite, full unit tests, typecheck, and lint. Report per-layer and total pass/fail counts. Diagnose failures under R11 and do not skip, mock, or weaken assertions merely to obtain a green result.
