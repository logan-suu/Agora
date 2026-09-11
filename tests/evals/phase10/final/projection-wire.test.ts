// Only external HTTP responses are scripted; Harness, MCP, file reads and Go serialization are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState } from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { HarnessExecutor, project } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { createToolCatalog } from '@agora/tools-bridge';
import { WorktreeRegistry } from '@agora/tools-fs';
import { expect, it, vi } from 'vitest';
import { BudgetLedger } from './accounting';
import { CONFIG, MeteredAdapter } from './model-adapter';

type WireMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: { id: string }[];
};
type WireRequest = { messages: WireMessage[] };

it('preserves each actual MCP character-range result and matching tool identity in serialized Go follow-ups', async () => {
  const requests: WireRequest[] = [];
  vi.stubEnv('OPENCODE_API_KEY', 'offline-wire-fixture');
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const n = requests.length;
    if (n > 4) throw Error('Unexpected extra request in offline audit');
    const delta =
      n <= 3
        ? {
            role: 'assistant',
            reasoning_content: `Audit step ${n}.`,
            tool_calls: [
              {
                index: 0,
                id: `audit-read-${n}`,
                type: 'function',
                function: {
                  name: 'fs_read',
                  arguments: JSON.stringify({
                    path: 'audit.test.mjs',
                    range: { start: 0, end: 120 },
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Done' };
    const frames = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: n <= 3 ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 200,
        },
      },
    ];
    return new Response(
      `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const root = await mkdtemp(join(tmpdir(), 'go-retention-audit-'));
  const sandbox = new LocalTempSandbox();
  const worktree = await sandbox.createWorktree('go-retention-audit', 'REVIEWER');
  const content = '// The repeated read returns exactly 120 characters.\n'.repeat(10);
  await sandbox.write(worktree, 'audit.test.mjs', content);
  const registry = new WorktreeRegistry();
  registry.register(worktree.path);
  const catalog = await createToolCatalog({ registry, sandbox, getWorktree: async () => worktree });
  const adapter = new MeteredAdapter(
    new BudgetLedger(join(root, CONFIG.budgetFile), 5, 3),
    'offline-wire',
    'diagnostic',
  );
  const role = DEFAULT_ROSTER.find((r) => r.role === 'REVIEWER');
  if (!role) throw Error('Missing reviewer');
  const executor = new HarnessExecutor(
    { ...role, model: 'deepseek-v4-flash' },
    { adapter, tools: catalog.all(), allowTools: ['fs_read'] },
  );
  try {
    await executor.step({
      sessionId: 'wire-retention-audit',
      view: project(
        createInitialAppState('wire-retention-audit', 'Read the test file'),
        'REVIEWER',
        DEFAULT_ROSTER,
      ),
    });
    expect(requests).toHaveLength(4);
    for (let i = 1; i < 4; i++) {
      const messages = requests[i]?.messages ?? [];
      const results = messages.filter((m) => m.role === 'tool');
      const calls = messages.flatMap((m) => m.tool_calls ?? []);
      const ids = Array.from({ length: i }, (_, j) => `audit-read-${j + 1}`);
      expect(results.map((m) => m.tool_call_id)).toEqual(ids);
      expect(calls.map((c) => c.id)).toEqual(ids);
      for (const result of results)
        expect(JSON.parse(result.content ?? '')).toBe(content.slice(0, 120));
      for (let j = 1; j <= i; j++)
        expect(messages.filter((m) => m.reasoning_content === `Audit step ${j}.`)).toHaveLength(1);
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
      for (let index = 0; index < messages.length; index++) {
        const toolCalls = messages[index]?.tool_calls ?? [];
        for (let offset = 0; offset < toolCalls.length; offset++)
          expect(messages[index + offset + 1]).toMatchObject({
            role: 'tool',
            tool_call_id: toolCalls[offset]?.id,
          });
      }
    }
    expect(adapter.calls).toHaveLength(4);
  } finally {
    await executor.dispose();
    await catalog.dispose();
    await sandbox.teardown('go-retention-audit');
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
