---
name: agora-test-unit
description: Run and analyze Agora unit tests for a task or path together with type and lint checks, without silently weakening tests.
---

# Run Agora unit checks

Resolve the requested task or test path from `docs/task-status.json`. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test`; when a path is specified, also run the focused Vitest target. Report counts and coverage against the task's documented contract. On failure, identify whether production behavior, the test, or the environment is at fault using evidence and R11. Do not change code or assertions unless the user explicitly requests a fix.
