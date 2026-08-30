---
name: agora-read-spec
description: Read and summarize the controlling Agora specifications for a task, quoting exact constraints and decisions without changing code or task state.
---

# Read Agora specifications

Choose the user-specified task, otherwise the current `in_progress` task in `current_phase` or the first `ready` task in `current_phase`. Read its `documents_required` sections and only the topic-specific sections mapped by `AGENTS.md` section 0.2. Quote interface signatures, schemas, decision rules, relevant standing decisions, and red lines verbatim with file and section references. Identify conflicts or missing specification explicitly. This workflow is read-only.
