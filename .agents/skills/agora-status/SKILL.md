---
name: agora-status
description: Report the current Agora phase, task progress, next ready work, milestone, exit criteria, and Git state without modifying the project.
---

# Report Agora status

Read `docs/task-status.json` and report the current phase, overall and phase-local status counts, `in_progress` tasks, the next `ready` task, current exit criteria, and nearest incomplete milestone. Include `git status --short --branch` and the repository's latest status timestamp. This workflow is read-only; do not cascade or edit task states.
