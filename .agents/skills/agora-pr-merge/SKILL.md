---
name: agora-pr-merge
description: Close out an Agora task after a human has merged its PR by syncing dev-1.0.0, recording evidence, cascading readiness, and checking phase completion.
---

# Close out a merged Agora PR

Use only after the user requests post-merge closeout. Verify the PR state is `MERGED`; if not, stop and report it. Sync `dev-1.0.0`, identify the exact task and merge commit, and delete a local feature branch only when Git confirms it is merged.

Update only the task's status, timestamps, notes, G5 evidence, and deferral references in `docs/task-status.json`; mark it `done`, cascade eligible tasks to `ready`, and evaluate phase completion. The documented direct-push exemption applies only to a commit containing `docs/task-status.json` closeout data and requires explicit user authorization for the push. Never auto-merge a PR or mix source changes into the exempt commit.
