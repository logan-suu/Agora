---
name: agora-explain
description: Explain Agora code, architecture decisions, or domain concepts by tracing them to exact project specification text.
---

# Explain Agora with specification provenance

Read task context through `node scripts/task-status.mjs summary`, then `task <id>`, `phase <id>`, or `decisions <id...>` as needed. Do not dump the entire index or batch-load histories. Read the selected decisions’ source sections before implementation or review; summaries are navigation, not complete specifications.

Use `AGENTS.md` section 0.2 to locate the controlling documents for the requested concept or code. Quote the most relevant source text verbatim and cite its file and section. Explain the design intent, current implementation, and immediate dependency impact. Distinguish documented facts from inference; if no direct specification exists, say so instead of inventing one. Do not edit files unless the user separately requests a change.
