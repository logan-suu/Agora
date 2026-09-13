# Agora product demo: English recording script

最新状态（2026-09-12 本地时间）：录制9已完成自然语言改价、真实确认、返工验证及 Leader 完成终审，产物已归档。新英文成片长 3分22秒，1920×1080，实拍片段保持1×、删去等待并说明返工；无音轨。归档6文件匹配15b4aa96，18项产物测试＋8项独立检查全过，工作树/容器已释放。视频播放与14处拖动定位检查通过，三个原片段无浏览器异常。成片、时间线和下载包见[新演示说明](task106-natural-chat-demo.md)。旧视频已按要求删除；下文早期暂停及待录制状态均为历史记录。T10.6仍保持in_progress，未commit/push。

历史状态（2026-09-12）：Leader授权删除旧录制并开始新录制。旧媒体已删除，代码产物、State与会话保留。录制7英文模块入口遗漏已修复；录制8已实测并行和自然语言确认改价，但最终测试布局返工移除累计测试触发保护，已停用录像。现补齐角色测试职责和继承测试保留提示，保持硬保护；完成全回归后用新任务quote-en-take-9重新录制。最终完成仍须本次候选的Leader终审，T10.6保持in_progress。

Historical status: take 3 stopped after a real pending-send draft race was found, and its Go worker subsequently failed after a timeout. The draft fix passes browser checks, production build and all 1,216 regression tests. The product stopped gracefully and failed videos were deleted. The Leader requested a timeout review before any provider switch or new recording; see task106-timeout-review.md. No take is ready to publish. Future recording helpers must correlate each response with its exact request display and wait for canonical application before submitting the next update. Earlier status paragraphs below are historical.

Historical recording status, 2026-09-12: failed recordings 1 and 2 were discarded after the assignment-scope and reasoning-replay fixes passed verification. Their videos were deleted at the Leader's request; failure evidence remains. Fresh task `quote-en-take-3` is being recorded with 1M context / 384K output and the existing Go connection. The original HTTP 400 from take 2 could not be reproduced with synthetic controls; do not claim a confirmed cause. The current source passed 1,216 regression tests and a real Go Harness tool-loop check. Await this task's own Leader completion decision before presenting it as a completed demo. Earlier status and budget paragraphs below are historical.

Historical status, 2026-09-12: quote-demo-en-3 has reached its Leader completion gate at commit 4b8e2cce8b180db76259077571be9a0961caad82, with 38 cumulative tests and 8 independent checks passing. Reviewer approved. A JSON presentation gap found during rehearsal has been fixed and passed 1,214 regression tests plus desktop/mobile checks. The Leader approved completion; the task is done, all nine archived files match the validated commit, and the archived 38-test suite plus eight independent checks pass. Refresh and resource cleanup are verified. The run uses 1M context / 384K output. Temporary cost and request-count ceilings are removed; usage remains recorded and provider failures stop new requests for investigation. Use the existing Go connection. Formal recording was authorized on 2026-09-12 and started in the new task quote-demo-en-recording-1. This new candidate requires its own Leader completion decision.

Historical status: both earlier English rehearsals are incomplete. The second authorized rehearsal, `quote-demo-en-2`, started at 2026-09-12T02:45:59Z and applied both requirement updates, but a CODER request timed out through two automatic retries during rework. Formal recording remains paused. The Go stream-idle policy has been revised after an offline reproduction; validation is recorded separately from model success. Neither earlier approval authorizes further attempts or final completion. The earlier `quote-demo-3` run remains historical evidence.

Historical update, 2026-09-11: the Leader approved proceeding to the English rehearsal after both final UI improvements passed verification. One new real attempt, `quote-demo-en-1`, is authorized under the existing cumulative USD 1 Go limit, using `deepseek-v4-flash`. This is a rehearsal without video capture; no formal recording or final completion approval is implied. The local guard admits only this attempt, caps it at 80 model requests, preserves the existing usage ledger, and refuses official-provider fallback. Repeated attempts require a further decision.

## Language and presentation

Rehearsal outcome, 2026-09-11: the Leader approved rework of the initial candidate; corrected 900-cent requirements applied and cumulative validation passed 18 tests. The helper's own 80-request cutoff then stopped the next C wave before final review. There is no supported continuation for this nongate failure. Preserve this incomplete attempt; see [rehearsal evidence](task106-english-rehearsal-evidence.md). The proposed next helper uses a request-count warning while retaining the cumulative USD 1 reservation guard. It has passed isolated offline checks but is not admitted for another attempt yet.

Use English throughout the captured experience: interface labels, system notices, task goals, requirements, acceptance criteria, Leader messages, agent explanations, and any visible code comments or test names. The cover, captions, closing card, and narration, if used, must also be in English. Keep identifiers and protocol keys unchanged. Check actual model output before accepting a take; an English prompt alone is not proof of an English run.

Capture the Agora page only. Keep unrelated tabs, operating system prompts, credentials, raw model reasoning, and private tool content outside the frame. Use an English browser locale. Retain visible native scrollbars; when using headless Playwright, omit its default `--hide-scrollbars` argument.

Create a fresh task after recording has been resumed and attempt authorization has been checked. Do not translate or replace persisted historical messages, or combine different runs to imply one continuous success. Preserve the original recording and identify any edits or accelerated waiting periods.

## Task goal to paste

```text
Build a small JavaScript calculator for event quotes using .mjs files and Node's built-in tests, with no external dependencies.

Tickets cost 1000 cents per person. The venue costs 5000 cents per hour. Have the team implement ticket costs and venue costs in separate modules in parallel, then add a quote module that combines them and returns the ticket cost, venue cost and total in integer cents.

Accept zero and non-negative integers. Reject negative, fractional and non-finite inputs with RangeError. Cover normal and invalid inputs with tests. Keep the scope to these modules and their tests; no CLI, server, UI or payment processing.

Use English for the team's messages, documentation, code comments and test names. Have the team verify and review the result before I approve completion.
```

This is a user request, not a role-protocol fixture. Do not inject requirement IDs, orchestration State or JSON commands into the composer. Before starting, pass this exact goal through the production evaluateComplexity function and verify Tier 2. Let the actual PM and Architect derive the requirements and plan. Verify real independent work and Trace overlap before using a parallel-work caption.

## Mid-task requirement change

During actual coding, type this ordinary message:

> Change the ticket price to 900 cents per person. Keep the other rules unchanged.

Wait for the actual model-generated proposal. Expand the proposed changes and read both Before and After, including related quote expectations. Confirm that the venue rate, invalid-input rules and non-goals remain intact. Click **Confirm changes** only when the proposal matches this request. If the model asks a clarification, answer it in ordinary English. If the proposal is wrong, discard it and clarify the request; do not repair it by pasting a command or injecting State from a helper.

Expected business result: two tickets cost 1800 cents; three venue hours still cost 15000 cents; the combined quote is 16800 cents. This is an independent acceptance check, not a hidden replacement for model interpretation.

The confirmation must create a canonical applied receipt for one atomic batch and update the actual requirements through the existing safe-point boundary. A visible draft or HTTP 202 alone is not evidence that requirements changed. Capture the natural-language input, the readable comparison and the real button click. Browser helpers may click and inspect evidence, but must not manufacture proposals, submit browser-authored requirement bodies or resolve the task's completion gate without its own Leader approval.

## Shot and caption guide

| Shot | Suggested English caption | Evidence required |
| --- | --- | --- |
| Opening | Agora: a group chat for your AI development team | The actual local product page |
| Task creation | One goal, a team of specialized agents | Browser submission and persisted progress for the new task |
| Requirements and plan | Clear requirements become a dependency-aware plan | Actual PM and ARCHITECT output rendered in the chat |
| Parallel work | Independent modules can run in parallel | Overlapping CODER activity in the actual Trace |
| Requirement update | Change a requirement while the team is working | Formal Leader message and canonical applied receipt |
| Validation | Tests validate the cumulative artifact | Current test receipt and matching commit |
| Review | The reviewer checks the result | Current review bound to the same artifact |
| Completion decision | The Leader makes the final call | Explicit Leader approval for this new candidate and its actual gate |
| Archive and refresh | The result remains available after refresh | Archived artifact, retained messages, and restored task status |
| Closing | Local orchestration. Traceable work. Human control. | No unsupported speed or success-rate claims |

Use these captions only when the corresponding behavior is visible and verified. Do not prefill a success count, overlap duration, commit, gate, or result from the historical run. A successful review is not final completion; wait for the Leader to approve the new candidate before resolving its completion gate.

## Acceptance before delivery

- All visible text and any narration are in English, including transient notices, expanded task details, structured delivery cards, and any expanded original JSON.
- Markdown, task details, native chat scrolling, and narrow layouts remain readable; no placeholder or debug text appears.
- New messages follow while the viewer is at the bottom. Reading earlier messages preserves the scroll position and shows an unread count without counting duplicate message IDs. "Back to latest" clears the notice and restores following. New dispatch notices stay concise; the complete goal is available in the task sidebar.
- The final artifact uses the updated price and agrees with the current validation receipt and review. Record the actual tests and result from this run.
- The recording shows the real browser-to-Harness/MCP/Git/Docker path, a verified overlap, the applied requirement change, Leader completion approval, archive, and refresh.
- Media hashes, source version and working-tree differences, actual run identities, model settings, usage, cleanup, and edit timings are recorded separately. No secret values are exposed.
- If language drifts or a product defect appears, stop the affected recording and investigate. A script, translated overlay, or screenshot is not a replacement for the required English end-to-end recording.


## Current model capacity

The project now uses the verified 1,000,000-token context window for all six DeepSeek V4 Flash Agents. Use the model-supported 384,000-token maximum output and automatic Harness history compaction. The earlier 8,192-token demo setting has been removed. Confirm these settings before a separately authorized new rehearsal. Existing tasks and benchmark snapshots retain their original bindings; do not present them as runs at the new capacity.
