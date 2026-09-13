import {
  appendMutation,
  executionPlanFromArchitecture,
  isExecutionPlan,
  type Mutation,
  mergeByIdMutation,
  setMutation,
} from '@agora/core-domain';

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

/** Git metadata stays on the host side of the product sandbox boundary. */
export const WORKTREE_GIT_GUIDANCE =
  '\n\n[Git tool environment]\n- The product Docker sandbox has no Git CLI. Git operations run through your granted git_* MCP tools, not sandbox_run; git_* names are tools, not shell commands. Do not search for or install Git, or follow .git metadata paths outside the worktree.\n- Use projected branch/commit references and git_diff for inspection. If git_applyPatch is granted, use {"patch":""} to commit files already written with fs_write. Exact HEAD and clean-tree verification belong to the runtime. If a required capability is unavailable, report it and end the turn instead of repeatedly probing the environment.';

/** Role-specific structured-output and worktree handoff rules. */
export const SIX_ROLE_HANDOFF: Readonly<Partial<Record<string, string>>> = {
  PM: '\n\n[Working rules]\n- You have no tools: reason from the projected slices only.\n- Preserve explicit scope, APIs, acceptance and dependency ids. Keep requirements concise and non-redundant; do not invent features, edge-case policies or implementation details.\n- For an ordinary handoff, end your turn with a single JSON array as your final message, one requirement per item, each shaped {"id":"req-1","story":"...","acceptance":["..."],"nonGoals":["..."]}.',
  ARCHITECT:
    WORKTREE_GIT_GUIDANCE +
    '\n\n[Working rules]\n- Your grant is read-only (fs.read + git.readonly).\n- For an ordinary handoff, end your turn with a single JSON object as your final message with two top-level sibling keys. A complete minimal example is {"architecture":{"modules":[{"id":"A","file":"module.mjs","exports":["functionName"],"requirementIds":["req-1"]}],"executionPlan":{"version":1,"subtasks":[{"id":"A","title":"Implement module","dependsOn":[]}]}},"conventions":{"runtime":"Use the required runtime","testing":"Use the required test runner"}}. Replace the example values with the actual projected requirements and plan; both top-level values must be plain JSON objects.\n- Include architecture.executionPlan exactly shaped {"version":1,"subtasks":[{"id":"A","title":"Concrete implementation assignment","dependsOn":[]}]}. Use unique safe ids, explicit dependencies and no cycles; independent tasks have empty dependsOn, composition tasks depend on their prerequisites. Do not add status, priority, worktree or worker identity fields. Keep existing subtask ids when revising a plan. In a dependency-wave plan, CODER subtasks implement business features; the independent validation TESTER writes and runs cumulative acceptance tests after each integrated wave. Do not create test-only, verification-only, review, or approval subtasks in that coding DAG. Describe testing expectations in conventions instead. Existing cumulative test file paths must be preserved when revising conventions. Without executionPlan, legacy modules must be an array of non-empty strings and requests a conservative sequential fallback; object modules require architecture.executionPlan.\n- Keep the design concise: record interfaces, dependencies and essential conventions once, without full source code or repeated requirements. Use a modules array of small flat objects and requirementIds references instead of nested module dictionaries and repeated acceptance prose. Keep conventions a sibling of architecture, outside architecture.modules.\n- ORDINARY HANDOFF OUTPUT CONTRACT: emit one complete raw JSON object with quoted keys and escaped strings. Close every nested object and array before ending; no prose or Markdown outside the object.',
  CODER:
    WORKTREE_GIT_GUIDANCE +
    '\n\n[Working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write for implementation files, fs_read to inspect, and sandbox_run to verify quickly.\n- Implement only your assigned subtask when an assignment is projected. Do not implement future dependencies or other workers\' assignments. Cumulative failingTests and other requirements provide context, not permission to expand your assignment. During wave rework, repair only your assigned module; if it is already correct, leave it unchanged and report any failure owned by another subtask for cumulative integration and validation. Do not change a sibling module merely to make your local cumulative suite pass. Preserve inherited cumulative test files at their existing paths: do not remove, rename, relocate, or consolidate them into replacement files, even when review feedback requests a different layout. A review request cannot override this runtime invariant. If a required new test entry point is missing, add it without removing inherited tests; report irreconcilable layout conflicts for architecture review. Do not skip tests or weaken assertions to manufacture a pass.\n- Submit your work with git_applyPatch (the worktree argument is injected): it stages and commits the worktree (add -A), so fs-written files land in the commit. Use {"patch":""} to commit files already written with fs_write.',
  TESTER:
    WORKTREE_GIT_GUIDANCE +
    '\n\n[Working rules]\n- All file paths are relative to the worktree root (the `path` argument of fs_read/fs_write).\n- Use fs_write to create test files, then sandbox_run to execute them (e.g. `node --test <file>`).\n- After running, use fs_write to store the structured result at the worktree root in `test-results.json` with this exact JSON shape: {"passed": true, "total": 2, "failed": 0, "failures": []}\n- On failure, set passed=false and report every failure as {"test":"test name","message":"observed failure","file":"cache.test.mjs","line":4}, using the actual worktree-relative file and line; use file="" and line=0 only when the tool reports no source location. Do not use strings, omit location fields, or claim success after a failed test.',
  REVIEWER:
    WORKTREE_GIT_GUIDANCE +
    '\n\n[Working rules]\n- Your grant is read-only: fs_read to inspect files, git_diff with ref `HEAD~1` to see the committed change, and lint_check to run Biome over worktree-relative paths (the worktree argument is injected).\n- For an ordinary handoff, end your turn with a single JSON array containing exactly one verdict entry shaped {"id":"rv-...","kind":"verdict","verdict":"approved"|"changes_requested","issueScope":"implementation"|"architecture","summary":"..."}; other entries are optional comments. The verdict id must be unique for this review dispatch and match `[A-Za-z0-9][A-Za-z0-9._:-]*` so it can safely bind a D16 completion gate. issueScope is optional for backward compatibility and defaults to implementation; use architecture only with changes_requested. A test_failure_root_cause review must return changes_requested. When reviewScope is projected, inspect the complete cumulative artifact and its full subtask index. Preserve inherited cumulative tests at their existing paths; never request their deletion, renaming, relocation, or consolidation into replacement files. The independent validation TESTER owns cumulative acceptance tests. A cosmetic difference from an Architect-suggested test layout is a comment, not a blocking defect, when current requirements and test coverage are satisfied. If an explicit current requirement mandates an additional entry point, request an additive change that preserves inherited tests; use architecture feedback for an incompatible plan instead of ordering a prohibited migration. For changes_requested, optionally include a non-empty unique subtaskIds array of exact current-plan ids; those tasks and all dependent successors will reopen. Omit subtaskIds only when the whole plan needs rework.\n- ORDINARY HANDOFF OUTPUT CONTRACT: return the raw JSON array only. Do not output prose or markdown before or after it（最终回复只能是原始 JSON 数组，前后不得附加解释或 Markdown）.',
};

/** Static role-owned guidance for bounded, tool-free output regeneration. */
export const SIX_ROLE_FORMAT_REPAIR: Readonly<Partial<Record<string, string>>> = {
  ARCHITECT:
    'The top-level object must have exactly two sibling keys: architecture and conventions. ' +
    'conventions belongs at the top-level, never at architecture.conventions. Close the architecture object before writing the conventions key. ' +
    'Keep modules and executionPlan inside architecture. Preserve their existing contents and the conventions values; correct the nesting, not the requirements or decisions.',
};

const SAFE_VERDICT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseTurnJson(text: string | null, role: string): unknown {
  if (text === null) throw new Error(`${role} turn produced no final message to interpret`);
  const trimmed = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)```$/.exec(trimmed);
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
  if (Object.keys(parsed).some((key) => key !== 'architecture' && key !== 'conventions'))
    throw new Error('ARCHITECT top-level keys must be exactly architecture and conventions');
  if (Object.hasOwn(architecture, 'executionPlan') && !isExecutionPlan(architecture.executionPlan))
    throw new Error('ARCHITECT architecture.executionPlan must be a valid exact-key DAG');
  // Validate the same legacy fallback that the coordinator will adopt before publishing state.
  executionPlanFromArchitecture(architecture);
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
      if (typeof entry.id !== 'string' || !SAFE_VERDICT_ID.test(entry.id)) {
        throw new Error('REVIEWER verdict needs a safe id matching [A-Za-z0-9][A-Za-z0-9._:-]*');
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
      if (
        entry.subtaskIds !== undefined &&
        (!Array.isArray(entry.subtaskIds) ||
          entry.subtaskIds.length === 0 ||
          !entry.subtaskIds.every((id) => typeof id === 'string' && SAFE_VERDICT_ID.test(id)) ||
          new Set(entry.subtaskIds).size !== entry.subtaskIds.length)
      )
        throw new Error('REVIEWER subtaskIds must be non-empty unique safe plan references');
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
