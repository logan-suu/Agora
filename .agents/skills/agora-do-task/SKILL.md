---
name: agora-do-task
description: Execute a specified Agora task ID through dependency checks, specification locking, approved planning, TDD, quality gates, and verification.
---

# Execute an Agora task

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Require a task ID or report the current phase's `ready` and `pending` tasks. Query `task <id>`; reject `done`, explain `blocked`, and require confirmation before resuming `in_progress`. Verify every dependency and the cross-phase gate.

After authorization, set the task to `in_progress`, read its `documents_required` sections, quote controlling text verbatim, and surface ambiguity before implementation. Present a concrete plan and wait for approval. Then implement in small TDD units, run proportionate tests plus `pnpm typecheck`, `pnpm lint`, and `pnpm test`, perform any required real-chain G5 check, synchronize affected documentation, and append full evidence to task history and replace notes with a short current summary and references. Do not mark the task `done`; hand off to `$agora-commit` and later `$agora-pr-merge`.
