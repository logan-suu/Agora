// The HTTP service scripts provider responses; Harness and its HTTP/SSE adapter are real.

import { once } from 'node:events';
import { createServer } from 'node:http';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { expect, it } from 'vitest';
import { HarnessExecutor } from '../src/harness-executor';

it.each([
  'http://example.com/v1',
  'http://localhost.example.com/v1',
  'ftp://example.com/v1',
  'file:///tmp/model',
  'https://user:private-key@example.com/v1',
  'https://example.com/v1?key=private-key',
  'https://example.com/v1#private-key',
  'not-a-url',
])('rejects unsafe direct executor URL %s before installing transport', async (baseURL) => {
  const spec = PHASE0_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const originalFetch = globalThis.fetch;
  let executor: HarnessExecutor | undefined;
  try {
    expect(() => {
      executor = new HarnessExecutor(spec, {
        compatible: {
          id: 'invalid-url',
          baseURL,
          model: 'deepseek-v4-flash',
          contextWindow: 32768,
          maxTokens: 128,
          resolveApiKey: async () => 'never-resolved',
        },
      });
    }).toThrow('invalid model service URL');
    expect(globalThis.fetch).toBe(originalFetch);
  } finally {
    await executor?.dispose();
  }
});

it.each([
  'https://example.com/v1',
  'http://localhost/v1',
  'http://127.0.0.1/v1',
  'http://[::1]/v1',
])('accepts a secure or loopback direct executor URL %s', async (baseURL) => {
  const spec = PHASE0_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const executor = new HarnessExecutor(spec, {
    compatible: {
      id: 'valid-url',
      baseURL,
      model: 'deepseek-v4-flash',
      contextWindow: 32768,
      maxTokens: 128,
      resolveApiKey: async () => undefined,
    },
  });
  await executor.dispose();
});

it('isolates concurrent connection credentials and sanitizes terminal provider errors', async () => {
  const received: { url: string | undefined; auth: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume the request before responding. */
    }
    received.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/error/chat/completions') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'private-provider-error-key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: 'parallel', object: 'chat.completion.chunk', created: 1, model: 'parallel-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const spec = PHASE0_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const make = (id: string, key?: string) =>
    new HarnessExecutor(
      { ...spec, model: 'parallel-model' },
      {
        compatible: {
          id,
          baseURL: `${baseURL}/${id}`,
          model: 'parallel-model',
          contextWindow: 32768,
          maxTokens: 128,
          resolveApiKey: async () => key,
        },
      },
    );
  const keyed = make('keyed', 'scoped-key');
  const anonymous = make('anonymous');
  const failing = make('error', 'private-provider-error-key');
  const step = (executor: HarnessExecutor, sessionId: string) =>
    executor.step({ sessionId, view: { role: 'COORDINATOR', slices: {} } });
  try {
    await Promise.all([step(keyed, 'a'), step(anonymous, 'b')]);
    expect(received).toEqual(
      expect.arrayContaining([
        { url: '/keyed/chat/completions', auth: 'Bearer scoped-key' },
        { url: '/anonymous/chat/completions', auth: undefined },
      ]),
    );
    await expect(step(failing, 'c')).rejects.toMatchObject({
      message: 'Model request failed after bounded recovery.',
      code: 'AUTH',
      cause: {
        message: 'Configured model request failed',
        failure: { message: 'Configured model request failed' },
      },
    });
    expect(received.filter((r) => r.url === '/error/chat/completions')).toHaveLength(1);
    const ordinary = await fetch(`${baseURL}/outside`, {
      method: 'POST',
      headers: { authorization: 'Bearer unrelated' },
    });
    await ordinary.text();
    expect(received.at(-1)).toEqual({ url: '/outside', auth: 'Bearer unrelated' });
  } finally {
    await Promise.all([keyed.dispose(), anonymous.dispose(), failing.dispose()]);
    server.close();
    await once(server, 'close');
  }
}, 60000);

it('sends the configured model and key through the official compatible provider without redirecting', async () => {
  const requests: { authorization: string | undefined; model: string; url: string | undefined }[] =
    [];
  let redirect = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ authorization: req.headers.authorization, model: body.model, url: req.url });
    if (redirect) {
      res.writeHead(307, { location: '/stolen' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'configured' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const spec = PHASE0_ROSTER.find((r) => r.role === 'COORDINATOR');
  if (!spec) throw new Error('missing Coordinator');
  const make = () =>
    new HarnessExecutor(
      { ...spec, model: 'custom-model' },
      {
        compatible: {
          id: 'test-connection',
          baseURL: `http://127.0.0.1:${port}/v1`,
          model: 'custom-model',
          contextWindow: 32768,
          maxTokens: 4096,
          resolveApiKey: async () => 'test-secret',
        },
      },
    );
  const executor = make();
  try {
    await executor.step({ sessionId: 'custom-session', view: { role: 'COORDINATOR', slices: {} } });
    expect(requests).toEqual([
      { authorization: 'Bearer test-secret', model: 'custom-model', url: '/v1/chat/completions' },
    ]);
    redirect = true;
    await expect(
      executor.step({ sessionId: 'custom-session-2', view: { role: 'COORDINATOR', slices: {} } }),
    ).rejects.toThrow();
    expect(requests.every((r) => r.url !== '/stolen')).toBe(true);
  } finally {
    await executor.dispose();
    server.close();
    await once(server, 'close');
  }
}, 60000);
