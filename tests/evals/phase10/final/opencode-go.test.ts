// Only external HTTP responses are scripted; official serialization, SSE parsing and accounting run unchanged.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { afterEach, expect, it, vi } from 'vitest';
import { BudgetLedger } from './accounting';
import { CONFIG, costOf, MeteredAdapter } from './model-adapter';
import { OFFICIAL_CONFIG } from './model-profile';
import { resolveOpenCodeGoApiKey } from './opencode-go';

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'agora-go-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('resolves only Go credentials without copying or falling back to another provider', async () => {
  const authPath = join(await root(), 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      'opencode-go': { type: 'api', key: 'go-fixture' },
      deepseek: { type: 'api', key: 'other-fixture' },
    }),
  );
  expect(await resolveOpenCodeGoApiKey({ env: {}, authPath })).toBe('go-fixture');
  expect(
    await resolveOpenCodeGoApiKey({ env: { OPENCODE_API_KEY: 'env-fixture' }, authPath }),
  ).toBe('env-fixture');
  await expect(
    resolveOpenCodeGoApiKey({ env: { OPENCODE_API_KEY: '' }, authPath }),
  ).rejects.toThrow('invalid');
  await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api', key: 'other-fixture' } }));
  await expect(resolveOpenCodeGoApiKey({ env: {}, authPath })).rejects.toThrow(
    'other providers are not a fallback',
  );
  await writeFile(authPath, '{"key":"SECRET_FIXTURE_BROKEN');
  await expect(resolveOpenCodeGoApiKey({ env: {}, authPath })).rejects.toThrow(
    'credential unavailable',
  );
});

it('serializes Go model and compaction requests with the native stable session header and parses usage offline', async () => {
  vi.stubEnv('OPENCODE_API_KEY', 'go-wire-fixture');
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    });
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 7,
        },
      },
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  });
  const ledger = new BudgetLedger(join(await root(), CONFIG.budgetFile), 20, 17);
  const meter = new MeteredAdapter(ledger, 'go-wire', 'diagnostic');
  for (const [model, purpose] of [
    ['deepseek-v4-flash', undefined],
    ['deepseek-v4-flash', 'compaction'],
    ['deepseek-flash', undefined],
    ['deepseek-flash', 'compaction'],
  ]) {
    const options = {
      model,
      sessionId: 'stable-go-session',
      messages: [],
      tools: [
        {
          name: 'fs_read',
          description: 'Read task evidence.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      ...(purpose === undefined ? {} : { purpose }),
    } as unknown as GenerateOptions;
    for await (const _chunk of meter.stream(options)) {
      /* Consume the official SSE parser. */
    }
    expect(options.tools).toHaveLength(1);
  }
  expect(requests).toHaveLength(4);
  for (const [index, request] of requests.entries()) {
    if (index % 2 === 1) expect(request.body.tools).toBeUndefined();
    else
      expect(request.body.tools).toEqual([
        expect.objectContaining({ function: expect.objectContaining({ name: 'fs_read' }) }),
      ]);
  }
  for (const request of requests) {
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer go-wire-fixture');
    expect(request.headers.get('x-deepseek-harness-session-id')).toBe('stable-go-session');
    expect(request.headers.get('user-agent')).toContain('deepseek-harness/');
    expect(request.body).toMatchObject({ max_tokens: 32768 });
  }
  expect(requests.map((r) => r.body.model)).toEqual([
    'deepseek-v4-flash',
    'deepseek-v4-flash',
    'deepseek-flash',
    'deepseek-flash',
  ]);
  for (const index of [1, 3])
    expect(requests[index]?.headers.get('x-deepseek-harness-compact')).toBe('1');
  expect(
    meter.calls.every((call) => call.costUsd !== undefined && call.usage?.cacheReadTokens === 3),
  ).toBe(true);
  expect(JSON.stringify(meter.calls)).not.toContain('go-wire-fixture');
  expect(ledger.spent).toBeGreaterThan(0);
});

it('keeps official cost accounting separate and rejects missing sessions before credential resolution or I/O', async () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  expect(costOf('deepseek-v4-flash', usage, true, OFFICIAL_CONFIG)).toBeCloseTo(1.774);
  expect(costOf('deepseek-v4-flash', usage, true)).toBeCloseTo(1.506);
  expect(costOf('deepseek-flash', usage, true)).toBeCloseTo(1.506);
  expect(costOf('deepseek-flash', usage, false)).toBeCloseTo(0.753);
  expect(costOf('deepseek-v4-pro', usage, true)).toBeUndefined();
  expect(costOf('deepseek-v4-pro', usage, true, OFFICIAL_CONFIG)).toBeCloseTo(5.324);
  expect(CONFIG.modelRequestsEnabled).toBe(false);
  const fetch = vi.fn(() => {
    throw new Error('unexpected network');
  });
  vi.stubGlobal('fetch', fetch);
  const directory = await root();
  expect(
    () =>
      new MeteredAdapter(
        new BudgetLedger(join(directory, 'phase10-budget.json'), 20, 17),
        'old',
        'formal',
      ),
  ).toThrow('separate quota ledger');
  const ledger = new BudgetLedger(join(directory, CONFIG.budgetFile), 20, 17);
  const meter = new MeteredAdapter(ledger, 'missing-session', 'diagnostic');
  const consume = async () => {
    for await (const _chunk of meter.stream({
      model: 'deepseek-v4-flash',
      messages: [],
    } as unknown as GenerateOptions)) {
    }
  };
  await expect(consume()).rejects.toThrow('stable Harness sessionId');
  expect(fetch).not.toHaveBeenCalled();
  expect(ledger.spent).toBe(0);
});

it('preserves tool identity through the actual Go SSE parser when continuation fields are empty', async () => {
  vi.stubEnv('OPENCODE_API_KEY', 'go-wire-fixture');
  vi.stubGlobal('fetch', async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-live-shape',
                  function: { name: 'read_audit', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: '', function: { name: null, arguments: '{}' } }],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 674, completion_tokens: 65 },
      },
    ];
    return new Response(
      `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const ledger = new BudgetLedger(join(await root(), CONFIG.budgetFile), 20, 17);
  const meter = new MeteredAdapter(ledger, 'identity-wire', 'diagnostic');
  const chunks = [];
  for await (const chunk of meter.stream({
    model: 'deepseek-v4-flash',
    sessionId: 'wire-identity',
    messages: [],
  } as unknown as GenerateOptions))
    chunks.push(chunk);
  expect(chunks.find((c) => c.type === 'block-end')).toMatchObject({
    block: { type: 'tool-call', id: 'call-live-shape', name: 'read_audit', arguments: '{}' },
  });
  expect(meter.calls[0]?.costBasis).toBe('uncached-input-upper-bound');
});
