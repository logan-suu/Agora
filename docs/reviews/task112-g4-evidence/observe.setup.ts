// Transparent diagnostics: only whitelisted metadata and counts are persisted.
// Original model input, output bytes, tools, assertions and deadlines are unchanged.
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HarnessExecutor } from '@agora/runtime-executor';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { afterAll, expect } from 'vitest';
import { basename } from 'node:path';

const root = `.data/diagnostics/agora112-full-g4-review/${basename(expect.getState().testPath!)}`;
mkdirSync(root, { recursive: true });
const started = Date.now();
const records: Record<string, unknown>[] = [];
const requests: any[] = [];
const now = () => Date.now() - started;
function emit(stage: string, details: Record<string, unknown> = {}) {
  const record = { atMs: now(), stage, ...details };
  records.push(record);
  appendFileSync(`${root}/events.jsonl`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
function snapshot(stage: string) {
  writeFileSync(`${root}/progress.json`, JSON.stringify({ stage, elapsedMs: now(), requests, events: records }, null, 2), { mode: 0o600 });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.hostname !== 'opencode.ai' || !url.pathname.endsWith('/chat/completions')) return originalFetch(input, init);
  const text = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
  const body = JSON.parse(text);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const session = headers.get('x-deepseek-harness-session-id');
  if (body.model !== 'deepseek-v4-flash') throw new Error('diagnostic only permits the selected Go V4 Flash model');
  const r: any = {
    id: requests.length + 1, startMs: now(), model: body.model,
    maxTokens: body.max_tokens, thinking: body.thinking?.type,
    messages: body.messages?.length, tools: body.tools?.length ?? 0,
    requestBytes: Buffer.byteLength(text),
    nativeSessionHeaderPresent: session !== null,
    sessionHash: session === null ? null : createHash('sha256').update(session).digest('hex'),
    userAgentPresent: headers.has('user-agent'),
    responseModels: [],
    comments: 0, dataFrames: 0, reasoningChars: 0, textChars: 0,
    toolArgumentChars: 0, toolDeltas: 0, emptyToolIds: 0,
    wireBytes: 0, parseErrors: 0, oversizedLines: 0, done: false,
    finishReasons: [],
  };
  requests.push(r);
  emit('request', { request: r.id, model: r.model, tools: r.tools, messages: r.messages, requestBytes: r.requestBytes, maxTokens: r.maxTokens });
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  signal?.addEventListener('abort', () => { r.abortMs = now(); emit('request-abort', { request: r.id }); }, { once: true });
  let response: Response;
  try { response = await originalFetch(input, init); }
  catch (error) { r.fetchErrorMs = now(); emit('fetch-error', { request: r.id }); throw error; }
  r.headersMs = now(); r.status = response.status;
  emit('headers', { request: r.id, status: response.status });
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let buffer = '';
  let discarding = false;
  function line(value: string) {
    if (value.startsWith(':')) { r.comments++; r.firstCommentMs ??= now(); r.lastCommentMs = now(); return; }
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (data === '[DONE]') { r.done = true; r.doneMs = now(); emit('sse-done', { request: r.id }); return; }
    r.dataFrames++; r.firstDataMs ??= now(); r.lastDataMs = now();
    try {
      const event = JSON.parse(data);
      if (typeof event.model === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(event.model) && !r.responseModels.includes(event.model)) r.responseModels.push(event.model);
      if (event.usage) {
        r.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'].filter(k => typeof event.usage[k] === 'number').map(k => [k, event.usage[k]]));
      }
      for (const choice of event.choices ?? []) {
        if (choice.finish_reason) {
          const reason = ['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) ? choice.finish_reason : 'other';
          r.finishReasons.push(reason); r.finishMs = now();
          emit('finish-reason', { request: r.id, reason });
        }
        const d = choice.delta ?? {};
        if (typeof d.reasoning_content === 'string' && d.reasoning_content.length) { r.reasoningChars += d.reasoning_content.length; r.firstReasoningMs ??= now(); }
        if (typeof d.content === 'string' && d.content.length) { r.textChars += d.content.length; r.firstTextMs ??= now(); }
        for (const tool of d.tool_calls ?? []) {
          r.toolDeltas++; r.firstToolMs ??= now();
          if (tool.id === '') r.emptyToolIds++;
          if (typeof tool.function?.arguments === 'string') r.toolArgumentChars += tool.function.arguments.length;
        }
      }
    } catch { r.parseErrors++; }
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      r.wireBytes += chunk.byteLength; r.lastBytesMs = now();
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, end).replace(/\r$/, '');
        if (!discarding) line(value);
        discarding = false; buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 131072) { buffer = ''; discarding = true; r.oversizedLines++; }
      controller.enqueue(chunk);
    },
    flush() {
      buffer += decoder.decode(); if (buffer && !discarding) line(buffer);
      r.streamEndMs = now(); emit('transport-end', { request: r.id });
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const originalStep = HarnessExecutor.prototype.step;
HarnessExecutor.prototype.step = async function(context) {
  const role = context.view.role;
  emit('executor-start', { role });
  try {
    const result = await originalStep.call(this, context);
    emit('executor-end', { role, kind: result.kind }); return result;
  } catch (error) { emit('executor-error', { role }); throw error; }
};
const originals = new Map<string, Function>();
for (const method of ['read', 'write', 'run'] as const) {
  const original = LocalTempSandbox.prototype[method]; originals.set(method, original);
  (LocalTempSandbox.prototype as any)[method] = async function(...args: any[]) {
    const start = now(); emit('sandbox-start', { operation: method });
    try {
      const result = await (original as Function).apply(this, args);
      emit('sandbox-end', { operation: method, elapsedMs: now() - start, ...(method === 'run' ? { exitCode: result.exitCode } : {}) }); return result;
    } catch (error) { emit('sandbox-error', { operation: method, elapsedMs: now() - start }); throw error; }
  };
}
emit('observer-start');
const interval = setInterval(() => snapshot('running'), 20000);
interval.unref();
afterAll(() => {
  clearInterval(interval); emit('observer-end'); snapshot('finished');
  globalThis.fetch = originalFetch; HarnessExecutor.prototype.step = originalStep;
  for (const [method, original] of originals) (LocalTempSandbox.prototype as any)[method] = original;
});
