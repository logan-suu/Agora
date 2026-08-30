---
name: agora-commit
description: Run Agora delivery gates, create an approved feature commit, push its branch, and open an English PR against dev-1.0.0.
---

# Commit and open an Agora PR

Use only when the user explicitly requests delivery. Inspect the branch, worktree, diff, task status, and required documentation. Never commit feature code on `main` or `dev-1.0.0`; create or use a `{type}/{kebab-description}` branch based on `dev-1.0.0`. Preserve unrelated changes and stage exact files only.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, the task-specific G5 real-chain check, and a sensitive-data review. Stop on any failure. Use an English imperative commit message and English PR title/body, push the feature branch, and open the PR with base `dev-1.0.0`. Keep the task `in_progress`, append the PR and gate evidence to notes, and never merge the PR.
