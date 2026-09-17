import type { RoleSpec } from '@agora/core-domain';

/** Preserve the role whitelist while replacing legacy filesystem tools with
 * the fixed-version local port. These readers never receive a source claim. */
export function localWorkspaceRole(source: RoleSpec): RoleSpec {
  if (source.role === 'CODER') return localCoderRole(source);
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
    systemPrompt: `${source.systemPrompt}\n\n[Local validation workspace contract]\nYour localWorkspace is an immutable snapshot of a plain directory. It has no Git branch or source write permission. Use workspace_read without a path to inspect the bound manifest, or with a relative path to read its original bytes. External source edits do not change this snapshot. Only TESTER may use workspace_run with the exact bound inputVersion and managed Node. @input/path addresses read-only snapshot files; @output/path addresses private output. Network is disabled. Do not invent successful test or command receipts. Report missing tests or unsupported validation to the Coordinator; you cannot edit source through this read-only binding. REVIEWER must assess the selected tested version and report its findings; only the Leader can approve completion.`,
  };
}

/** Variant for the approved direct CODER path. Other roles need their own
 * validation/read-only binding and must not inherit this capability set. */
export function localCoderRole(source: RoleSpec): RoleSpec {
  if (source.role !== 'CODER' || source.executor !== 'harness')
    throw Error('local_coder_role_required');
  const allowed = new Set(source.tools);
  const tools: string[] = [];
  if (allowed.has('fs.read') || allowed.has('workspace.read')) tools.push('workspace.read');
  if (allowed.has('fs.write') || allowed.has('workspace.apply')) tools.push('workspace.apply');
  if (allowed.has('sandbox.run') || allowed.has('workspace.run')) tools.push('workspace.run');
  return {
    ...source,
    tools,
    systemPrompt: `${source.systemPrompt}\n\n[Local workspace contract]\nYour assigned localWorkspace is a plain directory; generic worktree wording means only this assigned scope. Use only the granted workspace tools. Read each target first, including absent files. Every workspace_apply put carries its exact expected version and original readReceiptId, content and explicit utf8/base64 encoding; include additional unchanged read dependencies. If a file changed, reread it before proposing a new edit. A partial or needsAttention result requires Leader attention; do not repeatedly retry or hide it.\nUse workspace_read with no path to capture a current file manifest. Run approved managed Node with workspace_run against that exact inputVersion; @input/path refers to the immutable source copy, @output/path to this operation's writable output. Relative command cwd is private output. Network is disabled. The command cannot modify live source or read credentials. With a generate grant, toolId node-generate takes @input/script as its first argument and runs it in a private writable copy. Read a successful generated file using workspace_read with path and commandReceiptId, then review and apply it through normal versioned workspace_apply. With an install grant, pnpm-install takes one JSON argv string containing an array of {name,version,url,integrity}; every direct/dev dependency must have an exact matching version and approved HTTPS tarball with SHA-512 integrity. The first adapter rejects existing lock/config files, workspaces and source node_modules; unsupported or uncached transitive resolution fails explicitly. Downloads use the authorized broker; installation and lifecycle scripts are offline with private cache/home. Installed dependencies are immutable inputs selected for that complete source version, so source edits require a new install before dependency-backed validation. Preserve existing tests and user changes. Do not skip or weaken tests, write fabricated test results, invent a successful command receipt, or modify another assignment. Report actual run results and file references in the final handoff. Runtime verification and Leader completion approval remain required.`,
  };
}
