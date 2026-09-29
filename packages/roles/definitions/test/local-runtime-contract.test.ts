import { expect, it } from 'vitest';
import { localCoderRole } from '../src/local-runtime-contract';
import { DEFAULT_ROSTER } from '../src/roster';

it('uses versioned local tools without expanding a reduced role whitelist', () => {
  const coder = DEFAULT_ROSTER.find((role) => role.role === 'CODER');
  if (!coder) throw Error('missing coder');
  const result = localCoderRole(coder);
  expect(result.tools).toEqual(['workspace.read', 'workspace.apply', 'workspace.run']);
  expect(result.systemPrompt).toContain('expected');
  expect(result.systemPrompt).toContain('readReceiptId');
  expect(result.systemPrompt).not.toContain('fs_write');
  expect(localCoderRole({ ...coder, tools: ['fs.read'] }).tools).toEqual(['workspace.read']);
  expect(localCoderRole({ ...coder, tools: [] }).tools).toEqual([]);
  expect(() => localCoderRole({ ...coder, role: 'REVIEWER' })).toThrow('local_coder_role_required');
});

it('maps read-only local roles without granting source writes or generic shell access', async () => {
  const { localWorkspaceRole } = await import('../src/local-runtime-contract');
  for (const role of ['ARCHITECT', 'TESTER', 'REVIEWER']) {
    const spec = DEFAULT_ROSTER.find((entry) => entry.role === role);
    if (!spec) throw Error('missing role');
    const mapped = localWorkspaceRole(spec);
    expect(mapped.tools).toEqual(
      role === 'TESTER' ? ['workspace.read', 'workspace.run'] : ['workspace.read'],
    );
    expect(mapped.systemPrompt).toContain('immutable');
    expect(localWorkspaceRole({ ...spec, tools: [] }).tools).toEqual([]);
    expect(localWorkspaceRole({ ...spec, tools: ['fs.write', 'sandbox.run'] }).tools).toEqual(
      role === 'TESTER' ? ['workspace.run'] : [],
    );
  }
});

it('grants linked TESTER only its existing write whitelist and describes its private workspace', async () => {
  const { localWorkspaceRole } = await import('../src/local-runtime-contract');
  const tester = DEFAULT_ROSTER.find((entry) => entry.role === 'TESTER');
  const coder = DEFAULT_ROSTER.find((entry) => entry.role === 'CODER');
  if (!tester || !coder) throw Error('missing role');
  const mapped = localWorkspaceRole(tester, 'linked-worktree');
  expect(mapped.tools).toEqual(['workspace.read', 'workspace.apply', 'workspace.run']);
  expect(mapped.systemPrompt).toContain('independent validation worktree');
  expect(mapped.systemPrompt).toContain('readReceiptId');
  expect(mapped.systemPrompt).not.toContain('localWorkspace is an immutable snapshot');
  expect(localWorkspaceRole({ ...tester, tools: ['fs.read'] }, 'linked-worktree').tools).toEqual([
    'workspace.read',
  ]);
  expect(localWorkspaceRole({ ...tester, tools: [] }, 'linked-worktree').tools).toEqual([]);
  expect(localWorkspaceRole(coder, 'linked-worktree').systemPrompt).toContain(
    'private linked worktree',
  );
  expect(localWorkspaceRole(tester).tools).not.toContain('workspace.apply');
});

it('keeps a linked REVIEWER on the bound Git candidate with read-only tools', async () => {
  const { localWorkspaceRole } = await import('../src/local-runtime-contract');
  const reviewer = DEFAULT_ROSTER.find((entry) => entry.role === 'REVIEWER');
  if (!reviewer) throw Error('missing reviewer');
  const mapped = localWorkspaceRole(reviewer, 'linked-worktree');
  expect(mapped.tools).toEqual(['workspace.read']);
  expect(mapped.systemPrompt).toContain('validated Git candidate');
  expect(mapped.systemPrompt).toContain('Leader');
  expect(
    localWorkspaceRole({ ...reviewer, tools: ['fs.write', 'sandbox.run'] }, 'linked-worktree')
      .tools,
  ).toEqual([]);
});
