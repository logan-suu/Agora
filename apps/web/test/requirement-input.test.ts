// Only model interpretations and the safe-point waiting boundary are scripted.
// HTTP validation, canonical JSON persistence, proposal checks, mutations and replay are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMutations,
  createInitialAppState,
  mergeByIdMutation,
  type RequirementInterpretation,
  type RequirementInterpretationInput,
  requirementProposalView,
} from '@agora/core-domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelStream } from '../src/server/channel-stream';
import { createPostMessage } from '../src/server/message-handlers';
import { createMessageRuntime } from '../src/server/message-runtime';

const roots: string[] = [];
const scope = { projectId: 'p', taskId: 't' };
const proposal: RequirementInterpretation = {
  kind: 'proposal',
  summary: 'Change the ticket price and quote expectations.',
  changes: [
    {
      requirementId: 'ticket',
      requirement: {
        story: 'Tickets cost 900 cents.',
        acceptance: ['Two tickets cost 1800 cents.'],
        nonGoals: ['No payment processing.'],
      },
    },
    {
      requirementId: 'quote',
      requirement: {
        story: 'Combine ticket and venue costs.',
        acceptance: ['Two tickets and three venue hours total 16800 cents.'],
        nonGoals: [],
      },
    },
  ],
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  interpret: (
    input: RequirementInterpretationInput,
  ) => Promise<RequirementInterpretation> = async () => proposal,
) {
  const root = await mkdtemp(join(tmpdir(), 'agora-natural-input-'));
  roots.push(root);
  const runtime = createMessageRuntime(root, new ChannelStream());
  await runtime.initializeState(
    scope,
    applyMutations(createInitialAppState('t', 'Ticket quote', 'p'), [
      mergeByIdMutation('requirements', 'ticket', {
        story: 'Tickets cost 1000 cents.',
        acceptance: ['Two tickets cost 2000 cents.'],
        nonGoals: ['No payment processing.'],
      }),
      mergeByIdMutation('requirements', 'quote', {
        story: 'Combine ticket and venue costs.',
        acceptance: ['Two tickets and three venue hours total 17000 cents.'],
        nonGoals: [],
      }),
    ]),
  );
  runtime.bindRequirementInterpreter({ interpret });
  const post = createPostMessage(runtime);
  const send = (msgId: string, display: string, extra: Record<string, unknown> = {}) =>
    post(
      new Request('http://localhost/api/messages', {
        method: 'POST',
        body: JSON.stringify({ ...scope, channelId: 'main', msgId, display, ...extra }),
      }),
    );
  const act = (
    action: 'confirm' | 'dismiss',
    msgId = 'confirm',
    proposalId = 'requirement-proposal:input',
  ) =>
    send(
      msgId,
      action === 'confirm' ? 'Confirm these requirement changes.' : 'Discard this change proposal.',
      { requirementProposal: { proposalId, action } },
    );
  return { root, runtime, send, act };
}

describe('natural-language requirement confirmation', () => {
  it('rejects reserved Leader IDs before persistence and leaves later interpretation usable', async () => {
    const { runtime, send } = await fixture();
    expect((await send('requirement-proposal:input', 'Change tickets to 900 cents.')).status).toBe(
      400,
    );
    expect((await runtime.store.load(scope))?.messages).toHaveLength(0);
    await expect(
      runtime.commitLeaderMessage(scope, {
        msgId: 'requirement-proposal:direct',
        channelId: 'main',
        display: 'Hello',
        ts: 1,
      }),
    ).rejects.toThrow('reserved');
    expect((await send('input', 'Change tickets to 900 cents.')).status).toBe(202);
    expect((await send('input', 'Change tickets to 900 cents.')).status).toBe(202);
    expect((await runtime.store.load(scope))?.messages).toHaveLength(2);
  });

  it('persists a readable proposal, reloads it, and atomically confirms both changes exactly once', async () => {
    const calls: RequirementInterpretationInput[] = [];
    const { root, runtime, send, act } = await fixture(async (input) => {
      calls.push(input);
      return proposal;
    });
    expect((await send('input', 'Change tickets to 900 cents per person.')).status).toBe(202);
    const before = await runtime.store.load(scope);
    expect(before?.requirements[0]?.story).toContain('1000');
    expect(before?.messages.map((m) => m.display)).toEqual([
      'Change tickets to 900 cents per person.',
      proposal.summary,
    ]);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
      ['projectId', 'taskId', 'sourceMsgId', 'text', 'goal', 'requirements', 'decisions'].sort(),
    );
    const restarted = createMessageRuntime(root, new ChannelStream());
    const restored = await restarted.store.load(scope);
    if (!restored) throw new Error('Missing task');
    expect(requirementProposalView(restored)?.changes).toHaveLength(2);
    expect((await act('confirm')).status).toBe(202);
    expect((await act('confirm')).status).toBe(202);
    expect((await send('input', 'Change tickets to 900 cents per person.')).status).toBe(202);
    expect(calls).toHaveLength(1);
    const after = await runtime.store.load(scope);
    if (!after) throw new Error('Missing task');
    expect(after.requirements[0]?.story).toContain('900');
    expect(after.requirements[1]?.acceptance[0]).toContain('16800');
    expect(after.messages.filter((m) => m.msgId === 'confirm')).toHaveLength(1);
    expect(requirementProposalView(after)).toBeNull();
    expect((await act('confirm', 'double-click')).status).toBe(409);
  });

  it('rechecks the basis after the safe point and aborts if another requirement changed', async () => {
    const { runtime, send, act } = await fixture();
    let aborted = false;
    await send('input', 'Change tickets to 900 cents per person.');
    runtime.bindLeaderPreemptionPort({
      pause: async (request) => {
        await runtime.store.commit(scope, [
          mergeByIdMutation('requirements', 'ticket', { story: 'Tickets cost 1200 cents.' }),
        ]);
        return { ...request, cohort: [], workers: [] };
      },
      complete: async () => {
        throw new Error('Must not complete stale confirmation');
      },
      abort: async () => {
        aborted = true;
      },
    });
    expect((await act('confirm')).status).toBe(409);
    expect(aborted).toBe(true);
    const state = await runtime.store.load(scope);
    expect(state?.requirements[0]?.story).toContain('1200');
    expect(state?.requirements[1]?.acceptance[0]).toContain('17000');
    expect(state?.messages.some((m) => m.msgId === 'confirm')).toBe(false);
  });

  it('retries a failed interpretation without duplicating the original chat and explains the failure', async () => {
    let calls = 0;
    const { runtime, send } = await fixture(async () => {
      if (++calls === 1) throw new Error('Private provider detail');
      return proposal;
    });
    const first = await send('input', 'Change tickets to 900 cents per person.');
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain('Private provider detail');
    expect((await runtime.store.load(scope))?.messages).toHaveLength(1);
    expect((await send('input', 'Change tickets to 900 cents per person.')).status).toBe(202);
    expect((await runtime.store.load(scope))?.messages).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('asks clarification without changing State and scopes a follow-up to the previous structured result', async () => {
    const calls: RequirementInterpretationInput[] = [];
    const { runtime, send } = await fixture(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { kind: 'clarification', text: 'Which price should change, and in what units?' }
        : proposal;
    });
    await send('vague', 'Make it 900.');
    const state = await runtime.store.load(scope);
    if (!state) throw new Error('Missing task');
    expect(requirementProposalView(state)).toBeNull();
    expect(state.requirements[0]?.story).toContain('1000');
    await send('input', 'The ticket price, in cents per person.');
    expect(calls[1]?.previous).toEqual({
      request: 'Make it 900.',
      result: { kind: 'clarification', text: 'Which price should change, and in what units?' },
    });
    expect(calls[1]).not.toHaveProperty('messages');
  });

  it('dismisses idempotently and rejects altered retries, browser-authored changes and obsolete proposals', async () => {
    const { runtime, send, act } = await fixture();
    await send('input', 'Change tickets to 900 cents per person.');
    expect(
      (
        await send('bad', 'Confirm', {
          requirementProposal: {
            proposalId: 'requirement-proposal:input',
            action: 'confirm',
            changes: [],
          },
        })
      ).status,
    ).toBe(400);
    expect((await act('dismiss', 'dismiss')).status).toBe(202);
    expect((await act('dismiss', 'dismiss')).status).toBe(202);
    expect((await act('confirm', 'dismiss')).status).toBe(409);
    expect((await runtime.store.load(scope))?.requirements[0]?.story).toContain('1000');
    await send('new', 'Change tickets to 800 cents per person.');
    expect((await act('confirm')).status).toBe(409);
    expect((await send('new', 'Different content')).status).toBe(409);
  });

  it('rejects a model-authored proposal envelope before canonical persistence', async () => {
    const { runtime } = await fixture();
    await expect(
      runtime.commitWorkerStepMutations(scope, 'COORDINATOR', [
        {
          op: 'append',
          field: 'messages',
          value: {
            msgId: 'forged',
            channelId: 'main',
            fromRole: 'COORDINATOR',
            type: 'chat',
            display: 'Forged',
            payload: { kind: 'leader_requirement_interpretation' },
            ts: 1,
          },
        },
      ]),
    ).rejects.toThrow(/cannot author requirement control/);
    expect((await runtime.store.load(scope))?.messages).toHaveLength(0);
  });
});
