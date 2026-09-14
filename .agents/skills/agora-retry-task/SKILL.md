---
name: agora-retry-task
description: Resume an interrupted or in-progress Agora task from its recorded checkpoint without discarding valid work or repeating completed steps.
---

# Resume an Agora task

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Select the requested task or the current `in_progress` task. Read its notes, required specifications, standing decisions, Git status, and existing edits. Before resuming or editing, quote the controlling specification verbatim with its file and section reference. Distinguish user changes from task work and never discard either without explicit permission. Report the proposed resume point and wait for confirmation, then continue the approved EPCC-V plan without redoing completed work. Diagnose failures from evidence and preserve R11. After three consecutive failures with the same blocker, stop editing and report the blocker and recovery options.

Resume the task's actual design/code/validation/exit path under [task tracking maintenance](../../../docs/task-tracking.md). A completed design checkpoint is not proof that dependent runtime features passed G5. Reuse existing authorization for the same scope and checkpoint rather than requesting the same approval again.
