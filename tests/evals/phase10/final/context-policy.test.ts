import type { ChannelContext } from '@agora/comm-channels';
import { expect, it } from 'vitest';
import { applyContextPolicy } from './context-policy';

it('reduces only already authorized channel entries and preserves immutable input and counts', () => {
  const input: ChannelContext[] = [
    {
      channelId: 'private',
      kind: 'sub',
      topic: 'assigned',
      entries: Array.from({ length: 4 }, (_, n) => ({
        ref: { taskId: 't', msgId: `m${n}` },
        fromRole: 'CODER',
        type: 'handoff',
        content: { summary: `structured ${n}` },
      })),
      omittedRefs: [{ taskId: 't', msgId: 'prior' }],
      omittedRefCount: 5,
    },
  ];
  const original = structuredClone(input);
  const sparse = applyContextPolicy(input, 'sparse');
  expect(input).toEqual(original);
  expect(applyContextPolicy(input, 'current')).toEqual(input);
  expect(sparse[0]?.entries).toEqual(input[0]?.entries.slice(-2));
  expect(sparse[0]?.omittedRefCount).toBe(7);
  expect(sparse[0]?.omittedRefs.map((r) => r.msgId)).toEqual(['prior', 'm0', 'm1']);
  expect(sparse[0]?.channelId).toBe('private');
  expect(JSON.stringify(sparse).length).toBeLessThan(JSON.stringify(input).length);
});
