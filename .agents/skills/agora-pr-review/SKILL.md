---
name: agora-pr-review
description: Review an Agora pull request against project specifications, red lines, standing decisions, tests, and reviewer comments, with fix-and-recheck support when requested.
---

# Review an Agora PR

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Resolve the requested PR or current branch and inspect the actual diff and code. Read the task's required documents and check G1-G7, R1-R13, D1-D5/C4/FE/WO/DEF, interface stability, projection privacy, layering, test realism, documentation sync, and phase exit criteria. Report actionable findings first with severity, file, tight line location, rule, and concrete remediation.

Evaluate each human or bot comment against current code before accepting it. Before applying a fix, quote the controlling specification verbatim with its file and section reference. Fix valid in-scope findings when the user requested a fix-review cycle, rerun all gates, reply in English, and resolve only handled conversations. Defer only when the repository's stated criteria apply; record such items in `docs/deferred-items.json`. Never merge the PR.
