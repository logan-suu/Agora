import type { SubChannel } from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import { HarnessChannelSummaryGenerator } from '../src/index';

/**
 * G5 real chain for task 6.3. No test double: this traverses the production
 * tool-less HarnessExecutor and live DeepSeek provider. CI without credentials
 * skips; task verification records whether the local run actually executed.
 */
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== '';

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

describe.skipIf(!hasKey)('G5 real-chain: closed-channel summary over live thin Harness', () => {
  it('returns a strictly validated source-scoped summary without tools', async () => {
    const generator = new HarnessChannelSummaryGenerator({
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      model: 'deepseek-v4-flash',
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
