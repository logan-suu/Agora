---
name: agora-sync-docs
description: Synchronize Agora architecture and task documents after an approved decision or implementation change, preserving the repository's source-of-truth hierarchy.
---

# Synchronize Agora documentation

Determine the approved change and affected sources. Apply updates in this order: project blueprint decision or owning section; detailed design; system architecture and technology selection when affected; development plan and `docs/task-status.json`; then `AGENTS.md` if a red line or durable workflow rule changed. Update `standing_decisions` only as the summary index, set `docs/task-status.json.last_updated` after synchronization, and record deferrals only in `docs/deferred-items.json`.

For document conflicts, review the competing statements against product goals, confirmed decisions, implementation evidence and testability, then correct the owning section and synchronize affected sources directly (DOC-CONFLICT). Do not create or publish GitHub issues for these conflicts or add a conflict ledger to task status. Ask the Leader only when a substantive architectural choice remains unresolved, pausing code that depends on that choice. Preserve existing issue references as historical evidence.

Use `[YYYY-MM-DD 架构决策更新]` for architectural decisions and `[YYYY-MM-DD 选型同步]` for technology-selection changes. Search for stale terminology after editing and report every synchronized location.
