// Credential fixtures use real temporary files; no HTTP or model requests are made.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { HarnessExecutor } from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import { resolveLiveTestModel } from './live-model';

it('uses only Go V4 Flash and fails closed without its selected credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora-live-routing-'));
  const authPath = join(root, 'auth.json');
  try {
    await expect(resolveLiveTestModel({ env: {}, authPath })).rejects.toThrow(
      'credential unavailable',
    );
    const env = { DEEPSEEK_API_KEY: 'official-fixture' };
    await expect(resolveLiveTestModel({ env, authPath })).rejects.toThrow('credential unavailable');
    await writeFile(
      authPath,
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'go-fixture' } }),
    );
    expect(await resolveLiveTestModel({ env, authPath })).toMatchObject({
      model: 'deepseek-v4-flash',
      options: { provider: 'opencode-go' },
    });
    await expect(
      resolveLiveTestModel({ env: { ...env, AGORA_TEST_PROVIDER: 'deepseek-official' }, authPath }),
    ).rejects.toThrow('Go V4 Flash');
    await expect(
      resolveLiveTestModel({ env: { ...env, AGORA_EVAL_BUDGET_FILE: 'official.json' }, authPath }),
    ).rejects.toThrow('official regression budget');
    await expect(
      resolveLiveTestModel({ env: { ...env, OPENCODE_API_KEY: '' }, authPath }),
    ).rejects.toThrow('invalid OpenCode Go');
    await writeFile(authPath, JSON.stringify({ 'opencode-go': { type: 'api', key: '' } }));
    await expect(resolveLiveTestModel({ env, authPath })).rejects.toThrow('invalid OpenCode Go');
    await writeFile(authPath, '{invalid');
    await expect(resolveLiveTestModel({ env, authPath })).rejects.toThrow('credential unavailable');
    await rm(authPath);
    await expect(
      resolveLiveTestModel({ env: { ...env, AGORA_TEST_PROVIDER: 'opencode-go' }, authPath }),
    ).rejects.toThrow('credential unavailable');
    await expect(
      resolveLiveTestModel({ env: { AGORA_TEST_PROVIDER: 'invalid' }, authPath }),
    ).rejects.toThrow('Go V4 Flash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Only HTTP/SSE is scripted below; the native adapter, Harness history and probe tool are real.
it('retains Go tool identity when continuation frames clear it before the next request', async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const body = await new Request(input, init).json();
    requests.push(body);
    const deltas =
      requests.length === 1
        ? [
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-probe',
                  type: 'function',
                  function: { name: 'probe', arguments: '' },
                },
              ],
            },
            {
              tool_calls: [
                { index: 0, id: '', type: 'function', function: { name: '', arguments: '{}' } },
              ],
            },
          ]
        : [{ content: 'OK' }];
    const chunks: unknown[] = deltas.map((delta) => ({
      choices: [{ index: 0, delta, finish_reason: null }],
    }));
    chunks.push({
      choices: [
        { index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' },
      ],
    });
    return new Response(
      `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const live = await resolveLiveTestModel({ env: { OPENCODE_API_KEY: 'go-fixture' } });
  const role = PHASE0_ROSTER.find((r) => r.role === 'CODER');
  if (!role) throw new Error('missing Coder');
  const executor = new HarnessExecutor(
    { ...role, model: live.model },
    {
      ...live.options,
      allowTools: ['probe'],
      tools: [
        {
          name: 'probe',
          description: 'Return a fixture status',
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => {
            calls++;
            return { ok: true };
          },
        },
      ],
    },
  );
  try {
    expect(
      await executor.step({ sessionId: 'go-identity-test', view: { role: 'CODER', slices: {} } }),
    ).toMatchObject({ kind: 'done', output: { text: 'OK' } });
    expect(calls).toBe(1);
    expect(requests).toHaveLength(2);
    const messages = requests[1]?.messages as {
      role: string;
      tool_calls?: { id: string; function: { name: string } }[];
      tool_call_id?: string;
    }[];
    expect(messages.find((m) => m.role === 'assistant')?.tool_calls).toMatchObject([
      { id: 'call-probe', function: { name: 'probe' } },
    ]);
    expect(messages.find((m) => m.role === 'tool')?.tool_call_id).toBe('call-probe');
  } finally {
    await executor.dispose();
    globalThis.fetch = original;
  }
});
