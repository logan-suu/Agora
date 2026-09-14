---
name: agora-do-task
description: Execute an Agora task ID through dependency checks, specification locking, approved planning, and the gates appropriate to design, code, validation, or phase acceptance.
---

# Execute an Agora task

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Require a task ID or report the current phase's `ready` and `pending` tasks. Query `task <id>`; reject `done` and explain `blocked`. For `in_progress`, recover the approved scope and checkpoint before continuing; ask only for authorization that is actually missing. Verify every dependency and the cross-phase gate.

After authorization, set the task to `in_progress`, read its `documents_required` sections, quote controlling text verbatim, and surface ambiguity before implementation. Present a concrete plan and obtain any missing plan approval; reuse approval already given for that scope.

Select the task path from its notes and actual deliverables using the task-type rules in [task tracking maintenance](../../../docs/task-tracking.md). Pure design produces reviewed contracts and any required spikes; do not invent product code or TDD tests just because the task has an ID. Validation runs the specified real checks, and phase acceptance still requires the complete phase gates. For product code, tests, or build/execution-script changes, use small TDD units, typecheck, lint, the full regression suite, and applicable real-chain G5. A design or validation label never exempts actual code changes.

Synchronize affected specifications and append complete evidence to task history with concise notes. Pure non-code deliverables may become `done` after explicit human acceptance under AGENTS.md section 8.1.2, followed by the normal dependency cascade. Tasks with code changes remain `in_progress` until a human merges their PR; use `$agora-commit` only when delivery is requested, then `$agora-pr-merge`. Commit-time gates remain unchanged for every delivery.
