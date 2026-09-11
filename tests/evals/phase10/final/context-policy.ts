import { CHANNEL_CONTEXT_BUDGET_CHARS, type ChannelContext } from '@agora/comm-channels';

/** The caller supplies the production default-deny projection, never raw messages. */
export function applyContextPolicy(
  input: readonly ChannelContext[],
  policy: 'current' | 'sparse',
): ChannelContext[] {
  return input.map((channel) => {
    const output = structuredClone(channel);
    if (policy === 'current') return output;
    const removed = output.entries.splice(0, Math.max(0, output.entries.length - 2));
    output.omittedRefCount += removed.length;
    output.omittedRefs.push(...removed.map((entry) => entry.ref));
    const size = () =>
      JSON.stringify({
        entries: output.entries,
        omittedRefs: output.omittedRefs,
        omittedRefCount: output.omittedRefCount,
      }).length;
    while (size() > CHANNEL_CONTEXT_BUDGET_CHARS && output.omittedRefs.length)
      output.omittedRefs.shift();
    if (size() > CHANNEL_CONTEXT_BUDGET_CHARS) throw new Error('invalid channel context budget');
    return output;
  });
}
