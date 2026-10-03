import type { RoleSpec, WorkspaceRefV1 } from '@agora/core-domain';

const rangeContextContract =
  '\n\n[Workspace version and resume context]\nworkspaceVersionChanges identifies a new observed workspace version. workspaceRangeResumes identifies the fresh session for this worker. Inherited file reads and tool errors belong to the parent session and are historical; they do not establish current contents or revoke the currently bound capability. After a return, inspect the current workspace and reread relevant files before reporting current contents, editing or claiming the work is complete. Use the current tool response to determine permission; report a new denial to the Leader without bypassing it. Neither registration nor a successful read grants validation or completion approval.';

/** Preserve the role whitelist while replacing legacy filesystem tools with
 * the fixed-version local port. Direct validation remains read-only. */
export function localWorkspaceRole(
  source: RoleSpec,
  mode: WorkspaceRefV1['mode'] = 'direct',
): RoleSpec {
  if (source.role === 'CODER') return localCoderRole(source, mode);
  if (mode === 'linked-worktree') {
    if (source.role === 'REVIEWER' && source.executor === 'harness') {
      const allowed = new Set(source.tools);
      return {
        ...source,
        tools: allowed.has('fs.read') || allowed.has('workspace.read') ? ['workspace.read'] : [],
        systemPrompt: `${source.systemPrompt}${rangeContextContract}\n\n[Local Git review contract]\nYour localWorkspace is the validated Git candidate bound to the current review receipt and exact commit. It is read-only. Use workspace_read only for files you need to inspect; do not write, run commands, or treat this verdict as completion approval. Report findings against that candidate. Only the Leader can approve completion.`,
      };
    }
    if (source.role !== 'TESTER' || source.executor !== 'harness')
      throw Error('local_workspace_role_required');
    return localWriterRole(source, mode);
  }
  if (source.executor !== 'harness' || !['ARCHITECT', 'TESTER', 'REVIEWER'].includes(source.role))
    throw Error('local_workspace_role_required');
  const allowed = new Set(source.tools);
  const tools: string[] = [];
  if (allowed.has('fs.read') || allowed.has('workspace.read')) tools.push('workspace.read');
  if (source.role === 'TESTER' && (allowed.has('sandbox.run') || allowed.has('workspace.run')))
    tools.push('workspace.run');
  return {
    ...source,
    tools,
    systemPrompt: `${source.systemPrompt}${rangeContextContract}\n\n[Local validation workspace contract]\nYour localWorkspace is an immutable snapshot of a plain directory. It has no Git branch or source write permission. Use workspace_read without a path to inspect the bound manifest, or with a relative path to read its original bytes. External source edits do not change this snapshot. Only TESTER may use workspace_run with the exact bound inputVersion and managed Node. @input/path addresses read-only snapshot files; @output/path addresses private output. Network is disabled. Do not invent successful test or command receipts. Report missing tests or unsupported validation to the Coordinator; you cannot edit source through this read-only binding. REVIEWER must assess the selected tested version and report its findings; only the Leader can approve completion.`,
  };
}

/** Variant for the approved direct CODER path. Other roles need their own
 * validation/read-only binding and must not inherit this capability set. */
export function localCoderRole(
  source: RoleSpec,
  mode: WorkspaceRefV1['mode'] = 'direct',
): RoleSpec {
  if (source.role !== 'CODER' || source.executor !== 'harness')
    throw Error('local_coder_role_required');
  return localWriterRole(source, mode);
}

function localWriterRole(source: RoleSpec, mode: WorkspaceRefV1['mode']): RoleSpec {
  const allowed = new Set(source.tools);
  const tools: string[] = [];
  if (allowed.has('fs.read') || allowed.has('workspace.read')) tools.push('workspace.read');
  if (allowed.has('fs.write') || allowed.has('workspace.apply')) tools.push('workspace.apply');
  if (allowed.has('sandbox.run') || allowed.has('workspace.run')) tools.push('workspace.run');
  return {
    ...source,
    tools,
    systemPrompt: `${source.systemPrompt}${rangeContextContract}\n\n[Local workspace contract]\n${mode === 'linked-worktree' ? (source.role === 'TESTER' ? 'Your assigned localWorkspace is an independent validation worktree. Add tests and fixtures here, preserve inherited tests and implementation, and do not write to the CODER workspace or original user directory.' : 'Your assigned localWorkspace is a private linked worktree, separate from the original user directory.') : 'Your assigned localWorkspace is a plain directory; generic worktree wording means only this assigned scope.'} Use only the granted workspace tools. Read each target first, including absent files. Every workspace_apply put carries its exact expected version and original readReceiptId, content and explicit utf8/base64 encoding; include additional unchanged read dependencies. If a file changed, reread it before proposing a new edit. A partial or needsAttention result requires Leader attention; do not repeatedly retry or hide it.\nUse workspace_read with no path to capture a current file manifest. Run approved managed Node with workspace_run against that exact inputVersion; @input/path refers to the immutable source copy, @output/path to this operation's writable output. Relative command cwd is private output. Network is disabled. The command cannot modify live source or read credentials. With a generate grant, toolId node-generate takes @input/script as its first argument and runs it in a private writable copy. Read a successful generated file using workspace_read with path and commandReceiptId, then review and apply it through normal versioned workspace_apply. With an install grant, pnpm-install takes one JSON argv string containing an array of {name,version,url,integrity}; every direct/dev dependency must have an exact matching version and approved HTTPS tarball with SHA-512 integrity. The first adapter rejects existing lock/config files, workspaces and source node_modules; unsupported or uncached transitive resolution fails explicitly. Downloads use the authorized broker; installation and lifecycle scripts are offline with private cache/home. Installed dependencies are immutable inputs selected for that complete source version, so source edits require a new install before dependency-backed validation. Preserve existing tests and user changes. Do not skip or weaken tests, write fabricated test results, invent a successful command receipt, or modify another assignment. Report actual run results and file references in the final handoff. Runtime verification and Leader completion approval remain required.`,
  };
}
