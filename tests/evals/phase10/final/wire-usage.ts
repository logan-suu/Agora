import type { TokenUsage } from '@deepseek-ai/dsh-llm';

/** Match the locked official adapter's disjoint usage mapping, including v4 detail fields. */
export function wireUsage(raw: string): TokenUsage | undefined {
  const frames = raw.split(/\r?\n/).some((line) => line.startsWith('data:'))
    ? raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
        .map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(raw)];
  const usage = frames
    .map((frame) => frame.usage)
    .filter(Boolean)
    .at(-1);
  if (!usage) return undefined;
  const cacheReadTokens =
    usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const inputTokens = usage.prompt_tokens - cacheReadTokens;
  const outputTokens = usage.completion_tokens;
  if ([inputTokens, cacheReadTokens, outputTokens].some((n) => !Number.isFinite(n) || n < 0))
    return undefined;
  return { inputTokens, cacheReadTokens, outputTokens };
}

/** Observe bytes on the actual consumer path, so provider abort-after-finish cannot lose usage. */
export function observeResponse(
  response: Response,
  finish: (usage: TokenUsage | undefined) => void,
): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    finish(undefined);
    return response;
  }
  const decoder = new TextDecoder();
  let buffer = '',
    usage: TokenUsage | undefined,
    invalid = false,
    ended = false;
  const sse = response.headers.get('content-type')?.includes('event-stream') ?? true;
  const inspect = (value: string) => {
    if (!value.startsWith('data:') || value.slice(5).trim() === '[DONE]' || !value.slice(5).trim())
      return;
    try {
      usage = wireUsage(value) ?? usage;
    } catch {
      invalid = true;
    }
  };
  const complete = () => {
    if (ended) return;
    ended = true;
    if (sse) inspect(buffer.trim());
    else
      try {
        usage = wireUsage(buffer);
      } catch {
        invalid = true;
      }
    finish(invalid ? undefined : usage);
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            complete();
            controller.close();
            return;
          }
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > 1_048_576) {
            invalid = true;
            buffer = '';
          }
          if (sse) {
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) inspect(line.trimEnd());
          }
          controller.enqueue(next.value);
        } catch (error) {
          complete();
          controller.error(error);
        }
      },
      async cancel(reason) {
        complete();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
