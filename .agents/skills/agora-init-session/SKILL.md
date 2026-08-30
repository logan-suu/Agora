---
name: agora-init-session
description: Initialize a new Agora development session by loading project status, selecting the current task, and locking its specification context before implementation.
---

# Initialize an Agora session

1. Read the repository `AGENTS.md` and `docs/task-status.json`.
2. Idempotently change every `pending` task whose dependencies are all `done` to `ready`.
3. Prefer a user-specified task. Otherwise report the current phase, any `in_progress` task in `current_phase`, and the first `ready` task in `current_phase` without starting implementation.
4. Read only the selected task's `documents_required` sections and relevant `standing_decisions`.
5. Quote the controlling constraints verbatim, report dependency state and any specification conflict, then wait for explicit approval before changing the task to `in_progress` or writing code.

Do not infer current phase or task status from `AGENTS.md`; `docs/task-status.json` is authoritative.
