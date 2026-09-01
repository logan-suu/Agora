import { appendMutation, type Mutation, mergeByIdMutation, setMutation } from '@agora/core-domain';

/** Tool groups exposed by the production six-role thin-executor runtime. */
export const SIX_ROLE_TOOL_SURFACE: readonly string[] = [
  'fs.read',
  'fs.write',
  'fs.list',
  'test.run',
  'sandbox.run',
  'git',
  'git.readonly',
  'lint',
];

/** Role-specific structured-output and worktree handoff rules. */
export const SIX_ROLE_HANDOFF: Readonly<Partial<Record<string, string>>> = {
  PM: '\n\n[Working rules]\n- You have no tools: reason from the projected slices only.\n- End your turn with a single JSON array as your final message, one requirement per item, each shaped {"id":"req-1","story":"...","acceptance":["..."],"nonGoals":["..."]}.',
  ARCHITECT:
    '\n\n[Working rules]\n- Your grant is read-only (fs.read + git.readonly).\n- End your turn with a single JSON object as your final message shaped {"architecture":{...},"conventions":{...}}; both values must be plain JSON objects.',
  CODER:
    '\n\n[Working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write for implementation files, fs_read to inspect, and sandbox_run to verify quickly.\n- Submit your work with git_applyPatch (the worktree argument is injected): it stages and commits the worktree (add -A), so fs-written files land in the commit.',
  TESTER:
    '\n\n[Working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write to create test files, then sandbox_run to execute them (e.g. `node --test <file>`).\n- After running, use fs_write to store the structured result at the worktree root in `test-results.json` with this exact JSON shape: {"passed": true, "total": 2, "failed": 0, "failures": []}',
  REVIEWER:
    '\n\n[Working rules]\n- Your grant is read-only: fs_read to inspect files, git_diff with ref `HEAD~1` to see the committed change, and lint_check to run Biome over worktree-relative paths (the worktree argument is injected).\n- End your turn with a single JSON array containing exactly one verdict entry shaped {"id":"rv-...","kind":"verdict","verdict":"approved"|"changes_requested","issueScope":"implementation"|"architecture","summary":"..."}; other entries are optional comments. The verdict id must be a stable non-empty string. issueScope is optional for backward compatibility and defaults to implementation; use architecture only with changes_requested. A test_failure_root_cause review must return changes_requested.\n- FINAL OUTPUT CONTRACT: return the raw JSON array only. Do not output prose or markdown before or after it（最终回复只能是原始 JSON 数组，前后不得附加解释或 Markdown）.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseTurnJson(text: string | null, role: string): unknown {
  if (text === null) throw new Error(`${role} turn produced no final message to interpret`);
  const trimmed = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`${role} final message is not valid JSON: ${String(error)}`);
  }
}

export function pmTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'PM');
  if (!Array.isArray(parsed))
    throw new Error('PM final message must be a JSON array of requirements');
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw new Error('PM requirement entries must be JSON objects');
    const { id, story, acceptance, nonGoals } = entry;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('PM requirement needs a non-empty string "id"');
    }
    if (typeof story !== 'string') throw new Error(`PM requirement "${id}" needs a string "story"`);
    if (!isStringArray(acceptance) || !isStringArray(nonGoals)) {
      throw new Error(`PM requirement "${id}" needs string arrays "acceptance"/"nonGoals"`);
    }
    return mergeByIdMutation('requirements', id, { story, acceptance, nonGoals });
  });
}

export function architectTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'ARCHITECT');
  if (!isRecord(parsed)) throw new Error('ARCHITECT final message must be a JSON object');
  const { architecture, conventions } = parsed;
  if (!isRecord(architecture)) {
    throw new Error('ARCHITECT payload needs a non-array object "architecture"');
  }
  if (!isRecord(conventions)) {
    throw new Error('ARCHITECT payload needs a non-array object "conventions"');
  }
  return [setMutation('architecture', architecture), setMutation('conventions', conventions)];
}

export function reviewerTurnMutations(text: string | null): Mutation[] {
  const parsed = parseTurnJson(text, 'REVIEWER');
  if (!Array.isArray(parsed))
    throw new Error('REVIEWER final message must be a JSON array of review entries');
  const entries = parsed.map((entry) => {
    if (!isRecord(entry)) throw new Error('REVIEWER review entries must be JSON objects');
    if (typeof entry.kind !== 'string') {
      throw new Error('REVIEWER review entries need a string "kind"');
    }
    if (entry.kind === 'verdict') {
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error('REVIEWER verdict needs a non-empty string id');
      }
      if (entry.verdict !== 'approved' && entry.verdict !== 'changes_requested') {
        throw new Error('REVIEWER verdict must be "approved" or "changes_requested"');
      }
      if (typeof entry.summary !== 'string' || entry.summary.length === 0) {
        throw new Error('REVIEWER verdict needs a non-empty string "summary"');
      }
      if (
        entry.issueScope !== undefined &&
        entry.issueScope !== 'implementation' &&
        entry.issueScope !== 'architecture'
      ) {
        throw new Error('REVIEWER verdict issueScope must be "implementation" or "architecture"');
      }
      if (entry.verdict === 'approved' && entry.issueScope === 'architecture') {
        throw new Error('REVIEWER approved verdict cannot use architecture issueScope');
      }
    }
    return entry;
  });
  const verdictCount = entries.filter((entry) => entry.kind === 'verdict').length;
  if (verdictCount !== 1) {
    throw new Error(`REVIEWER final message must contain exactly one verdict; got ${verdictCount}`);
  }
  return entries.map((entry) => appendMutation('reviewComments', entry));
}

/** Per-role final-text interpreters wired into HarnessExecutor. */
export const SIX_ROLE_TURN_MUTATION_READERS: Readonly<
  Partial<Record<string, (text: string | null) => Mutation[]>>
> = {
  PM: pmTurnMutations,
  ARCHITECT: architectTurnMutations,
  REVIEWER: reviewerTurnMutations,
};
