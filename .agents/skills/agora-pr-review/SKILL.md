---
name: agora-pr-review
description: Review an Agora pull request against project specifications, red lines, standing decisions, tests, and reviewer comments, with fix-and-recheck support when requested.
---

# Review an Agora PR

Resolve the requested PR or current branch and inspect the actual diff and code. Read the task's required documents and check G1-G7, R1-R13, D1-D5/C4/FE/WO/DEF, interface stability, projection privacy, layering, test realism, documentation sync, and phase exit criteria. Report actionable findings first with severity, file, tight line location, rule, and concrete remediation.

Evaluate each human or bot comment against current code before accepting it. Fix valid in-scope findings when the user requested a fix-review cycle, rerun all gates, reply in English, and resolve only handled conversations. Defer only when the repository's stated criteria apply; record such items in `docs/deferred-items.json`. Never merge the PR.
