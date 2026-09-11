import type { StreamChunk } from '@deepseek-ai/dsh-llm';

/** Go may clear tool identity in continuation frames; retain only proven identity.
 * Drain the provider before validating and publishing tool blocks, so a conflict
 * cannot execute a tool or abort the active token stream.
 */
export async function* normalizeGoToolStream(
  source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  const pending: StreamChunk[] = [];
  let holding = false;
  for await (const chunk of source) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') holding = true;
    if (holding) pending.push(chunk);
    else yield chunk;
  }
  const identities = new Map<number, { id?: string; name?: string }>();
  for (const chunk of pending) {
    const value =
      chunk.type === 'tool-call-delta'
        ? chunk
        : chunk.type === 'block-end' && chunk.block.type === 'tool-call'
          ? chunk.block
          : undefined;
    if (value === undefined || !('index' in chunk)) continue;
    const identity = identities.get(chunk.index) ?? {};
    for (const field of ['id', 'name'] as const) {
      const candidate = value[field];
      if (candidate === undefined || candidate === null || candidate === '') continue;
      if (
        typeof candidate !== 'string' ||
        (identity[field] !== undefined && identity[field] !== candidate)
      )
        throw new Error('conflicting Go tool identity');
      identity[field] = candidate;
    }
    identities.set(chunk.index, identity);
  }
  for (const identity of identities.values()) {
    if (!identity.id || !identity.name) throw new Error('missing Go tool identity');
  }
  for (const chunk of pending) {
    if (chunk.type === 'tool-call-delta') {
      const identity = identities.get(chunk.index);
      yield { ...chunk, id: identity?.id as typeof chunk.id, name: identity?.name as string };
    } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      const identity = identities.get(chunk.index);
      yield {
        ...chunk,
        block: {
          ...chunk.block,
          id: identity?.id as typeof chunk.block.id,
          name: identity?.name as string,
        },
      };
    } else yield chunk;
  }
}
