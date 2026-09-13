---
name: agora-test-phase
description: Audit, complete, and run the current Agora phase's cross-package integration tests against its exit criteria.
---

# Test the current Agora phase

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Read `current_phase`, its `integration_test`, exit criteria, completed task summaries and their linked full evidence, and existing `tests/integration/phaseN` coverage. Map real cross-package paths and identify P0 core orchestration, P1 infrastructure, and P2 contract gaps. Present any test-generation or code-change plan and wait for approval before editing. Prefer real sandbox, filesystem, process, Git, and tool implementations; document justified mocks. Run typecheck, lint, focused phase tests, and required regression tests. Set the integration task only to `in_progress`; completion still requires `$agora-commit` and post-merge `$agora-pr-merge`.
