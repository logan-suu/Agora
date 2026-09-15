import { AsyncLocalStorage } from 'node:async_hooks';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';

const scope = new AsyncLocalStorage<boolean>();
const wrappers = new WeakSet<typeof fetch>();

/** The locked native adapter has no request-body hook. Scope its wire-only compatibility
 * rule like the existing production transport policy; never rewrite Harness history.
 */
function install() {
  if (wrappers.has(globalThis.fetch)) return;
  const original = globalThis.fetch;
  const wrapped: typeof fetch = (input, init) => {
    if (!scope.getStore()) return original(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (
      url !== 'https://opencode.ai/zen/go/v1/chat/completions' ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new Error('unexpected Go regression request');
    const body = JSON.parse(init.body);
    if (body.model !== 'deepseek-v4-flash' || !Array.isArray(body.messages))
      throw new Error('unexpected Go regression payload');
    for (const message of body.messages) {
      if (message.role === 'assistant' && !Object.hasOwn(message, 'reasoning_content'))
        message.reasoning_content = '';
    }
    // Keep the exact native signal and headers; Request cloning can break abort followers.
    return original(input, { ...init, body: JSON.stringify(body) });
  };
  wrappers.add(wrapped);
  globalThis.fetch = wrapped;
}

/** Both native stream entry points, retries and iterator cleanup use the same async scope. */
export async function* withGoReasoning(
  source: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  install();
  const iterator = source()[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await scope.run(true, () => iterator.next());
      if (item.done) return;
      yield item.value;
    }
  } finally {
    await scope.run(true, () => iterator.return?.());
  }
}
