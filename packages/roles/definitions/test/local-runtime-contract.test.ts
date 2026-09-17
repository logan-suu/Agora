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
