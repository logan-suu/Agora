import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';

export interface CompatibleModelOptions {
  id: string;
  baseURL: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  resolveApiKey: () => Promise<string | undefined>;
}

/** Reject unsafe direct callers before creating plugins or resolving credentials. */
export function assertCompatibleModelURL(baseURL: string): void {
  let url: URL;
  try {
    if (typeof baseURL !== 'string' || baseURL.length > 2048) throw new Error();
    url = new URL(baseURL);
  } catch {
    throw new Error('invalid model service URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid model service URL');
}

/** An executor can resolve exactly its own immutable connection, never ambient credentials. */
class ConnectionCredentials extends CredentialProvider {
  constructor(
    ctx: Context,
    private readonly options: CompatibleModelOptions,
  ) {
    super(ctx);
  }
  async resolve(ref: CredentialRef) {
    if (ref !== 'AGORA_CONNECTION_KEY') return undefined;
    return {
      value: (await this.options.resolveApiKey()) ?? 'agora-no-auth',
      source: 'agora-connection',
    };
  }
  async describe() {
    return { configured: true, writable: false };
  }
  async set(): Promise<void> {
    throw new Error('connection credentials are immutable');
  }
  async unset(): Promise<void> {
    throw new Error('connection credentials are immutable');
  }
  async readRecord() {
    return undefined;
  }
  async describeRecord() {
    return { configured: false, writable: false };
  }
  async listRecords() {
    return [];
  }
  async modifyRecord(): Promise<never> {
    throw new Error('ambient authentication is disabled');
  }
  async deleteRecord(): Promise<void> {
    throw new Error('ambient authentication is disabled');
  }
}

const transport = new AsyncLocalStorage<{ url: string; noAuth: boolean; goSessionId?: string }>();
let installed = false;
/** pi-ai uses the SDK's global fetch; only requests inside this async scope receive this policy. */
function installTransportPolicy() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const policy = transport.getStore();
    if (!policy) return original(input, init);
    const request = new Request(input, init);
    if (request.url !== policy.url || request.method !== 'POST')
      return Promise.reject(new Error('model request destination mismatch'));
    const headers = new Headers(request.headers);
    if (policy.noAuth) headers.delete('authorization');
    headers.delete('cookie');
    if (policy.goSessionId !== undefined) headers.set('x-opencode-session', policy.goSessionId);
    // Temporary Request clones can lose their abort followers after GC in Node.
    // Keep the SDK's original signal connected directly to the actual fetch.
    const signal =
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined;
    return original(
      new Request(request, { headers, redirect: 'error' }),
      signal === undefined ? undefined : { signal },
    );
  };
}

export function installCompatibleModel(ctx: Context, options: CompatibleModelOptions) {
  assertCompatibleModelURL(options.baseURL);
  installTransportPolicy();
  const isGo = new URL(options.baseURL).hostname === 'opencode.ai';
  const goDeepSeek = isGo && ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(options.model);
  const provider = `agora-model-${options.id}`;
  const credentials = ctx.plugin(ConnectionCredentials, options);
  const plugin = ctx.plugin(PiAi, {
    providers: {
      [provider]: {
        api: 'openai-completions',
        baseURL: options.baseURL,
        apiKeyEnv: 'AGORA_CONNECTION_KEY',
        timeoutMs: isGo ? 300000 : 120000,
        streamIdleTimeoutMs: isGo ? 300000 : 30000,
        models: [
          {
            id: options.model,
            contextWindow: options.contextWindow,
            maxTokens: options.maxTokens,
            ...(goDeepSeek
              ? {
                  // Preserve the provider default while enabling native reasoning replay.
                  reasoningEfforts: {
                    low: 'low',
                    medium: 'high',
                    high: 'high',
                    xhigh: 'high',
                    max: 'max',
                  },
                  compat: {
                    thinkingFormat: 'deepseek' as const,
                    requiresReasoningContentOnAssistantMessages: true,
                  },
                }
              : {}),
          },
        ],
        retryPolicy: { mode: 'normal', maxRetries: 2 },
      },
    },
  });
  ctx.on('llm/stream', (request, next) => guarded(next, options, request.sessionId));
  return { provider, fibers: [credentials, plugin] };
}

async function* guarded(
  next: () => AsyncIterable<StreamChunk>,
  options: CompatibleModelOptions,
  sessionId?: string,
): AsyncIterable<StreamChunk> {
  const isGo = new URL(options.baseURL).hostname === 'opencode.ai';
  if (isGo && !sessionId)
    throw new LlmError('Go requests require a Harness session identity', 'INVALID_REQUEST');
  const policy = {
    url: `${options.baseURL}/chat/completions`,
    noAuth: (await options.resolveApiKey()) === undefined,
    ...(isGo ? { goSessionId: sessionId as string } : {}),
  };
  const iterator = transport.run(policy, () => next()[Symbol.asyncIterator]());
  try {
    while (true) {
      const item = await transport.run(policy, () => iterator.next());
      if (item.done) break;
      const chunk = item.value;
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        yield {
          ...chunk,
          reason: {
            kind: 'error',
            failure: {
              code: safeCode(chunk.reason.failure.code),
              message: 'Configured model request failed',
            },
          },
        };
      } else yield chunk;
    }
  } catch (error) {
    throw new LlmError(
      'Configured model request failed',
      error instanceof LlmError ? safeCode(error.code) : 'TRANSPORT',
    );
  } finally {
    await transport.run(policy, async () => {
      await iterator.return?.();
    });
  }
}

function safeCode(code: string) {
  return [
    'AUTH',
    'RATE_LIMIT',
    'QUOTA_EXCEEDED',
    'CONTEXT_WINDOW_EXCEEDED',
    'EMPTY_RESPONSE',
    'TRANSPORT',
    'SERVER',
    'BAD_REQUEST',
    'INVALID_REQUEST',
    'PI_AI_ERROR',
    'ABORTED',
    'INVALID_CREDENTIAL',
    'TIMEOUT',
  ].includes(code)
    ? code
    : 'PROVIDER_ERROR';
}
