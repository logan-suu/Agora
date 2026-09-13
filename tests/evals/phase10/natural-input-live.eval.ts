// Explicit live G5, not a Benchmark attempt or part of default pnpm test.
// All dependencies are real; only synthetic test requirements are provided.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeByIdMutation, requirementProposalView } from '@agora/core-domain';
import { GlobalScheduler } from '@agora/core-orchestration';
import { HarnessRequirementInterpreter } from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import { ChannelStream } from '../../../apps/web/src/server/channel-stream';
import { createPostMessage } from '../../../apps/web/src/server/message-handlers';
import { createMessageRuntime } from '../../../apps/web/src/server/message-runtime';
import { finishWithCleanup } from '../../integration/phase10/cleanup';
import { assertNaturalPriceChanges } from './natural-input-checks';

it('phase10 natural input live G5 confirms a real tool-free interpretation atomically', async () => {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error('Live G5 requires configured DeepSeek credentials');
  const root = await mkdtemp(join(tmpdir(), 'agora-natural-live-'));
  const scope = { projectId: 'synthetic-g5', taskId: 'ticket-price' };
  const messages = createMessageRuntime(root, new ChannelStream());
  const scheduler = new GlobalScheduler({ cap: 1 });
  const errors: unknown[] = [];
  let interpretations = 0;
  try {
    await messages.initialize(scope, 'Calculate ticket and venue quotes in integer cents.');
    await messages.commitMutations(scope, [
      mergeByIdMutation('requirements', 'ticket', {
        story: 'Tickets cost 1000 cents per person.',
        acceptance: ['Two tickets cost 2000 cents.'],
        nonGoals: ['No payment processing.'],
      }),
      mergeByIdMutation('requirements', 'quote', {
        story: 'Combine ticket and venue costs. Venue costs 5000 cents per hour.',
        acceptance: ['Two people and three venue hours total 17000 cents.'],
        nonGoals: [],
      }),
    ]);
    messages.bindRequirementInterpreter({
      interpret: async (input) => {
        interpretations++;
        const lease = await scheduler.acquire(
          input.projectId,
          input.taskId,
          `leader-input:${input.sourceMsgId}`,
        );
        try {
          return await new HarnessRequirementInterpreter('deepseek-v4-flash', {
            deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
            sessionPersistence: { root: join(root, 'sessions'), cwd: root, ...scope },
          }).interpret(input);
        } finally {
          scheduler.release(lease);
        }
      },
    });
    const post = createPostMessage(messages);
    const send = (msgId: string, display: string, extra = {}) =>
      post(
        new Request('http://localhost/api/messages', {
          method: 'POST',
          body: JSON.stringify({ ...scope, channelId: 'main', msgId, display, ...extra }),
        }),
      );
    const before = await messages.store.load(scope);
    const display =
      'Change the ticket price to 900 cents per person. Update both the ticket requirement and the combined quote expectations. Keep venue pricing and all unrelated constraints unchanged.';
    expect((await send('price-input', display)).status).toBe(202);
    const proposed = await messages.store.load(scope);
    if (!proposed) throw new Error('Missing state');
    expect(proposed.requirements).toEqual(before?.requirements);
    const proposal = requirementProposalView(proposed);
    if (!proposal) throw new Error('Missing proposal');
    assertNaturalPriceChanges(proposal.changes);
    expect((await send('price-input', display)).status).toBe(202);
    const choice = { requirementProposal: { proposalId: proposal?.proposalId, action: 'confirm' } };
    for (let replay = 0; replay < 2; replay++) {
      const response = await send('confirm-price', 'Confirm these requirement changes.', choice);
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toMatchObject({ action: { status: 'applied' } });
    }
    const state = await createMessageRuntime(root, new ChannelStream()).store.load(scope);
    for (const change of proposal?.changes ?? [])
      expect(state?.requirements.find((r) => r.id === change.requirementId)).toMatchObject(
        change.after,
      );
    expect(state?.messages.filter((m) => m.msgId === 'confirm-price')).toHaveLength(1);
    expect(interpretations).toBe(1);
    expect(scheduler.activeCount).toBe(0);
  } catch (error) {
    errors.push(error);
  } finally {
    await finishWithCleanup(errors, [() => rm(root, { recursive: true, force: true })]);
  }
}, 120_000);
