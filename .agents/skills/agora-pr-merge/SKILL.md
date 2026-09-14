---
name: agora-pr-merge
description: Close out an Agora task after a human has merged its PR by syncing dev-1.0.0, recording evidence, cascading readiness, and checking phase completion.
---

# Close out a merged Agora PR

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Use only after the user requests post-merge closeout. Verify the PR state is `MERGED`; if not, stop and report it. Sync `dev-1.0.0`, identify the exact task and merge commit, and delete a local feature branch only when Git confirms it is merged.

Before changing task state, verify that the task summary, linked full history, and PR evidence establish every applicable G1-G7 gate defined in `AGENTS.md`, including the real-chain G5 result when relevant. Stop before editing `docs/task-status.json` if any required gate lacks evidence.

Update only the task's status, timestamps, notes, G5 evidence, and deferral references in `docs/task-status.json`; mark it `done`, cascade eligible tasks to `ready`, and evaluate phase completion. The documented direct-push exemption applies only to a commit containing `docs/task-status.json` closeout data and requires explicit user authorization for the push. If closeout also changes a history file, use a normal feature branch and human-reviewed PR; that file is not covered by the exemption. Prefer referencing full evidence already delivered in the merged PR rather than duplicating it. Never auto-merge a PR or mix source changes into the exempt commit.

If a pure non-code task was already accepted and marked `done`, verify its acceptance evidence and preserve its state; record delivery without duplicating completion or undoing the dependency cascade. Apply the task-type rules in [task tracking maintenance](../../../docs/task-tracking.md); actual code or test changes still require the merged PR and applicable gates.

When a Phase 11+ exit completes, verify the release-candidate evidence required by development plan section 18.11. Keep phase completion separate from publishing: a dev-to-main release PR needs human merge, and tags/GitHub Releases need user authorization and verified candidate/artifact identity. Do not mark a release published without checking the actual tag and Release. Delaying publication does not block development once the phase exit is satisfied. Resolve historical pre-split task IDs through section 18.12 before using the current index.
