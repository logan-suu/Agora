---
name: agora-test-integration
description: Run Agora's cumulative integration and regression suite from Phase 0 through the current phase, including cross-phase data-flow coverage.
---

# Run cumulative Agora integration checks

Read `current_phase` from `docs/task-status.json`. Audit `tests/integration/cross-phase` against implemented phase-to-phase data flows; present a plan and wait for approval before adding missing tests. Run each phase integration suite from Phase 0 through the current phase, the cross-phase suite, full unit tests, typecheck, and lint. Report per-layer and total pass/fail counts. Diagnose failures under R11 and do not skip, mock, or weaken assertions merely to obtain a green result.
