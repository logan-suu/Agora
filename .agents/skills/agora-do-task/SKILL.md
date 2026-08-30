---
name: agora-do-task
description: Execute a specified Agora task ID through dependency checks, specification locking, approved planning, TDD, quality gates, and verification.
---

# Execute an Agora task

Require a task ID or report the current phase's `ready` and `pending` tasks. Read `docs/task-status.json`; reject `done`, explain `blocked`, and require confirmation before resuming `in_progress`. Verify every dependency and the cross-phase gate.

After authorization, set the task to `in_progress`, read its `documents_required` sections, quote controlling text verbatim, and surface ambiguity before implementation. Present a concrete plan and wait for approval. Then implement in small TDD units, run proportionate tests plus `pnpm typecheck`, `pnpm lint`, and `pnpm test`, perform any required real-chain G5 check, synchronize affected documentation, and record evidence in task notes. Do not mark the task `done`; hand off to `$agora-commit` and later `$agora-pr-merge`.
