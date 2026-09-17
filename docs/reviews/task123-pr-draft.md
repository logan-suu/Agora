# Add controlled local execution for plain directory workspaces

## Summary

Authorized plain directories can now participate in the existing Harness workflow without pretending to be Git worktrees. Leader grants, canonical task bindings, live worker leases and versioned native file transactions control every local operation. Project commands read immutable inputs and write fresh private outputs under Seatbelt, with durable process identity and bounded cleanup evidence.

The local composition preserves role-specific tools, cooperative pause, official Harness Fork resume, independent TESTER execution, REVIEWER version binding, Leader completion approval and verified artifact archival. Source or authorization changes invalidate current qualification while retaining the original evidence and user contents.

Generation runs in a private copy and returns candidates for normal versioned application. The first installation adapter downloads explicit integrity-pinned packages through the authorized HTTPS broker, runs managed pnpm offline, and freezes the actual dependency tree and lock for subsequent commands and independent validation. Missing dependency receipts fail closed. Native helpers are included in the desktop build/manifest pipeline, and local execution readiness requires a real isolation probe.

## Validation

- `pnpm typecheck` and `pnpm lint`: passed; 585 files checked by Biome.
- `pnpm test`: 7 script tests and 225 Vitest files / 1748 tests passed; zero failures or skips. Includes existing Docker regressions and live OpenCode Go `deepseek-v4-flash` tests. No formal Benchmark was run.
- Phase 12: 18 integration files / 168 tests passed, including the real local LRU, grant/MCP transactions, offline installation, fixed dependencies, pause/Fork and version-bound completion/archive paths.
- Additional native IPC qualification: parent and child can reach the disposable Unix listener and discover the securityd Mach endpoint in the baseline; both routes are denied under the production policy. No Keychain item was accessed.
- `pnpm build:sandbox-native` and `pnpm --filter @agora/desktop build`: passed. 609 frozen source/configuration hashes remained unchanged during the full regression.

## Scope

This remains an authorized preview path on Apple Silicon/macOS 26.5. The Leader waived macOS 15 hardware validation for Task 12.3 only; compatibility is still unverified and tracked in DEF-018. No new DMG or release is claimed.

The initial install adapter accepts complete exact direct/dev dependency plans. Existing lock/config files, workspace/override/optional/peer resolution, source node_modules and uncached transitive resolution are explicitly unsupported. It does not imply arbitrary ecosystem installation support. Ordinary project entry, Worktree integration, takeover UI and full exit/recovery retain their later task gates. Docker remains until Task 13.3.

Evidence: `docs/reviews/task123-acceptance.md`, `docs/task-history/12.3.md`, and `docs/reviews/task123-command-evidence/final-test-summary.json`.

Task: 12.3
