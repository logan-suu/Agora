# Phase 8 Eval fixture

Phase 8 authority, durable-resume, resource-release, and trace scenarios create isolated task
state, Harness JSONL sessions, and worktrees inside each Eval run root. This pinned marker versions
the deterministic catalog without copying user data or allowing the scripted LLM adapter to act as
the Leader.
