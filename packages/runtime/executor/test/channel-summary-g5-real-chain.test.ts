import type { SubChannel } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';
import { resolveLiveTestModel } from '../../../../tests/helpers/live-model';

import { HarnessChannelSummaryGenerator } from '../src/index';

/** Real tool-less Harness summary regression, using the Leader-selected OpenCode Go V4 Flash route. */
const liveModel = await resolveLiveTestModel();
const liveLabel = `${liveModel.options.provider}/${liveModel.model}`;

const channel: SubChannel = {
  channelId: 'sub-g5-summary',
  kind: 'sub',
  taskId: 'g5-summary',
  threadId: 'g5-thread',
  topic: 'Choose the durable ordering',
  createdBy: 'CODER',
  participants: ['leader', 'CODER'],
  closed: true,
};

describe(`G5 real-chain: closed-channel summary over live thin Harness (${liveLabel})`, () => {
  it('returns a strictly validated source-scoped summary without tools', async () => {
    const generator = new HarnessChannelSummaryGenerator({
      ...liveModel.options,
      model: liveModel.model,
    });

    const summary = await generator.generate({
      channel,
      entries: [
        {
          ref: { taskId: 'g5-summary', msgId: 'fact-1' },
          fromRole: 'CODER',
          type: 'feedback',
          content: {
            reason: 'The team chose message-first and revision-CAS second for recoverability.',
          },
        },
      ],
    });

    expect(summary.conclusion.length).toBeGreaterThan(0);
    expect(summary.sourceMsgIds.every((msgId) => msgId === 'fact-1')).toBe(true);
    expect(summary.keyDecisions.every((entry) => entry.rationale.length > 0)).toBe(true);
  }, 120_000);
});
