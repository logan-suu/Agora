---
name: agora-init-session
description: Initialize a new Agora development session by loading project status, selecting the current task, and locking its specification context before implementation.
---

# Initialize an Agora session

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications.

1. Read the repository `AGENTS.md` and run the read-only `summary` query.
2. Recheck `cascadeCandidates` against the canonical index and idempotently change eligible `pending` tasks to `ready`, updating timestamps. The query never writes; run `summary` again after workflow mutations.
3. Prefer a user-specified task. Otherwise report the current phase, any `in_progress` task in `current_phase`, and the first `ready` task in `current_phase` without starting implementation.
4. Query `task <id>` and relevant `decisions <id...>`, then read only the selected required/source sections. If all tasks are done, report that fact; do not create a new phase or reopen tasks.
5. Quote the controlling constraints verbatim, report dependency state and any specification conflict, then wait for explicit approval before changing the task to `in_progress` or writing code.

Do not infer current phase or task status from `AGENTS.md`; `docs/task-status.json` is authoritative.
