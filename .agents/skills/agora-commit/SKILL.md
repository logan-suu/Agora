---
name: agora-commit
description: Run Agora delivery gates, create an approved feature commit, push its branch, and open an English PR against dev-1.0.0.
---

# Commit and open an Agora PR

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications. For recovery or gate evidence, follow the task notes into `docs/task-history/<id>.md` and linked reports; `history <id>` returns a bounded tail with explicit pagination, not complete evidence. Keep notes as a current summary (at most 800 Unicode code points); append detailed records to task history before updating the index, and run `node scripts/task-status.mjs check`. Follow [task tracking maintenance](../../../docs/task-tracking.md) for record ownership and migration rules.

Use only when the user explicitly requests delivery. Inspect the branch, worktree, diff, task status, and required documentation. Never commit feature code on `main` or `dev-1.0.0`; create or use a `{type}/{kebab-description}` branch based on `dev-1.0.0`. Preserve unrelated changes and stage exact files only.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, the task-specific G5 real-chain check, and a sensitive-data review. Stop on any failure. Use an English imperative commit message and English PR title/body, push the feature branch, and open the PR with base `dev-1.0.0`. Keep the task `in_progress`, append full PR/gate evidence to task history and keep a concise PR/gate summary and references in notes, and never merge the PR.
