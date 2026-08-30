---
name: agora-test-phase
description: Audit, complete, and run the current Agora phase's cross-package integration tests against its exit criteria.
---

# Test the current Agora phase

Read `current_phase`, its `integration_test`, exit criteria, completed task notes, and existing `tests/integration/phaseN` coverage. Map real cross-package paths and identify P0 core orchestration, P1 infrastructure, and P2 contract gaps. Present any test-generation or code-change plan and wait for approval before editing. Prefer real sandbox, filesystem, process, Git, and tool implementations; document justified mocks. Run typecheck, lint, focused phase tests, and required regression tests. Set the integration task only to `in_progress`; completion still requires `$agora-commit` and post-merge `$agora-pr-merge`.
