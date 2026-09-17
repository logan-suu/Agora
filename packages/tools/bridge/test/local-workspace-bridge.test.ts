// The port spy is only for protocol rejection tests. Real native workspace
// execution is verified separately by the Phase 12 integration fixtures.
import type { BoundWorkspaceTools } from '@agora/runtime-sandbox';
import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { expect, it } from 'vitest';
import { createLocalWorkspaceCatalog } from '../src/local-workspace-bridge';

it('only exposes versioned workspace tools and binds actions to the trusted session/call', async () => {
  const calls: unknown[] = [];
  const port: BoundWorkspaceTools = {
    async read(actionId, path) {
      calls.push({ actionId, path });
      return {
        kind: 'absent',
        readReceiptId: 'receipt',
        version: { kind: 'absent', parentIdentity: '1:2', name: 'new.txt' },
      };
    },
    async inspect() {
      throw Error('unexpected inspect');
    },
    async apply() {
      throw Error('unexpected apply');
    },
    async run() {
      throw Error('unexpected run');
    },
  };
  const catalog = await createLocalWorkspaceCatalog({
    port,
    sessionId: 'session-one',
    capabilities: ['read', 'apply', 'run'],
  });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  for (const tool of catalog.all()) ctx.tools.register(tool);
  try {
    expect(catalog.all().map((t) => t.name)).toEqual([
      'workspace_read',
      'workspace_apply',
      'workspace_run',
    ]);
    expect(catalog.resolve(['fs.write', 'git', 'sandbox.run']).definitions).toEqual([]);
    const request = {
      callId: CallId('call-one'),
      name: 'workspace_read',
      arguments: { path: 'new.txt' },
      signal: new AbortController().signal,
    };
    expect((await ctx.tools.execute(request)).isError).not.toBe(true);
    expect((await ctx.tools.execute(request)).isError).not.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({
      actionId: expect.stringMatching(/^tool:[a-f0-9]{64}$/),
      path: 'new.txt',
    });
    expect(
      (await ctx.tools.execute({ ...request, arguments: { path: 'new.txt', actionId: 'spoof' } }))
        .isError,
    ).toBe(true);
    expect(
      (await ctx.tools.execute({ ...request, arguments: { path: 'new.txt', workerId: 'other' } }))
        .isError,
    ).toBe(true);
    expect(calls).toHaveLength(2);
  } finally {
    await catalog.dispose();
  }
});

it('does not register write or run capabilities for a read-only worker', async () => {
  const port = new Proxy({} as BoundWorkspaceTools, {
    get() {
      throw Error('must not invoke port');
    },
  });
  const catalog = await createLocalWorkspaceCatalog({
    port,
    sessionId: 'reader',
    capabilities: ['read'],
  });
  try {
    expect(catalog.all().map((t) => t.name)).toEqual(['workspace_read']);
    expect(catalog.lookup('workspace.apply')).toBeUndefined();
  } finally {
    await catalog.dispose();
  }
});
