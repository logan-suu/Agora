---
name: agora-status
description: Report the current Agora phase, task progress, next ready work, milestone, exit criteria, and Git state without modifying the project.
---

# Report Agora status

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications.

Use the read-only `summary` query and report the current phase, overall and phase-local status counts, `in_progress` tasks, the next `ready` task, current exit criteria, and the milestone relevant to the current phase. Historical pending milestone metadata can remain in the index; do not report an old milestone as the current next task or silently change its status. Include `git status --short --branch` and the repository's latest status timestamp. This workflow is read-only; do not cascade or edit task states.
