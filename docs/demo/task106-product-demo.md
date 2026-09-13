# Agora English product demo — diagnostic recording, 2026-09-12

**Historical evidence; video deleted on 2026-09-12:** the Leader identified that scripted JSON commands in the composer do not reflect real user interaction. The artifact and execution evidence remain valid, but the user experience is not accepted. Requirement changes need a genuine user-facing flow before a replacement recording.

The diagnostic video follows one real local task, `quote-en-take-6`, from a browser launch through parallel coding, a Leader requirement change, cumulative tests, review, human completion approval, archive and refresh. It is a selected product demonstration, not a benchmark or a reliability claim.

[Editing timeline](Agora-Product-Demo-2026-09-12.timeline.json) · [Download the six-file artifact](Agora-Quote-Demo-Artifact-2026-09-12.zip)

## What is shown

- PM and Architect organize ticket and venue modules as independent work, then the dependent quote module.
- Two Coder workers overlap in the real Harness trace. The Leader changes the ticket price from 1,000 to 900 cents through the normal message endpoint while work is active.
- Markdown and requirement cards keep explanations readable; detailed JSON remains expandable.
- Cumulative validation passes 26 tests. Reviewer approval is followed by a separate Leader completion decision.
- The task completes, archives its output and remains completed after a page refresh.

The resulting `quote(2, 3)` returns `{ tickets: 1800, venue: 15000, total: 16800 }` in cents. Zero is accepted; invalid input, including `Symbol` and `Object.create(null)`, throws `RangeError`. After archive, 26 project tests plus 8 independent checks pass again in a read-only, network-disabled Docker container. All six archived files match the approved commit byte for byte.

## Provenance

| Item | Recorded fact |
| --- | --- |
| Environment | Existing macOS local installation; browser, backend, Harness/MCP, Git and Docker on one machine |
| Project / task | `agora` / `quote-en-take-6` |
| Model | Six configured roles use OpenCode Go `deepseek-v4-flash`; 1,000,000-token context / 384,000-token output capacity |
| Product source | Base commit `45ae0985b69d0173c01e5f08fc0db71415975fdb` plus the uncommitted T10.6 working tree; 418-file SHA-256 manifest `09954421d8cbab001b9fc6ea6073041ce67d7b8182481ff389974e499043ea8b` |
| Source verification | 162 files / 1,229 tests passed, no skips; typecheck, lint and production build passed |
| Approved artifact commit | `3a5eb00f8c4a16b6290ac402401f7d3e5fe2f66d` |
| Validation receipt | `wave-validation:91ed398a-95a1-4858-b263-0cd8e6ae7104` |
| Reviewer verdict | `rv-9ed65e75-quality-review`, approved |
| Leader approval action | `02f2c50e-1797-4a50-b129-cbcdd8458e0b`, applied through `POST /api/messages` |
| Final state | `done`, gate cleared; state SHA-256 `9b21a0186e368d8aea0854972e8bd503a55f483826d6b8acce064716149dd58c` |
| Archive check | 34 passed / 0 failed; log SHA-256 `13e89c5f567e44499ed47cc0c679e8f306844fee732cd4e1c4c3039b9b2a7556` |
| Resource cleanup | No task containers by actual mount paths; no linked task worktrees; product stopped |
| Model requests | 41 requests, all HTTP 200 with known usage; no extra request for completion approval |
| Usage estimate | USD 0.069806496 at conservative Go peak rates for this run; this is not a provider invoice |

## Editing and interpretation

English chapter text surrounds actual browser footage. Waiting periods are cut, and retained footage plays at normal speed. Recording paused while awaiting the Leader's approval; the second raw segment resumes the same persisted task. The video explicitly marks that gap. Editorial title and evidence cards are not product UI. The timeline maps every retained clip to its raw segment and source time, with source and final media hashes. The video is silent and uses an English on-screen guide.

The withdrawn video, original segments and old recording caches were deleted at the Leader’s request on 2026-09-12. Canonical State/Harness sessions remain in the private local evidence area. Failed earlier takes are retained as diagnostic records, and their videos were deleted as requested. No other run supplies frames or approval to this video. This scenario demonstrates nonblocking requirement reprojection and a completion gate; it does not claim to demonstrate history compaction or a paused worker's true Fork. Model tool errors visible in Trace remain part of the recording; they are not hidden as a claim that every tool call succeeds.

Task 10.6 contains uncommitted code and documentation changes and remains `in_progress` pending the normal delivery/PR process. Phase 10 final acceptance (10.7) remains separate. Benchmark results are separately versioned in the [final report](../evals/phase10-opencode-go-final-report.md).
