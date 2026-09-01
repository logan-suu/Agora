import {
  createInitialAppState,
  createMainChannel,
  type Message,
  type SubChannel,
} from '@agora/core-domain';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_CONTEXT_BUDGET_CHARS,
  DerivedChannelContextBuilder,
  type ProjectChannelSnapshot,
} from '../src/index';

const sub: SubChannel = {
  channelId: 'sub-task-a',
  kind: 'sub',
  taskId: 'task-a',
  threadId: 'thread-a',
  topic: 'Private work',
  createdBy: 'CODER',
  participants: ['leader', 'CODER'],
  closed: false,
};

const project: ProjectChannelSnapshot = {
  projectId: 'project-a',
  revision: 1,
  channels: [createMainChannel(['COORDINATOR', 'CODER', 'TESTER']), sub],
};

function message(overrides: Partial<Message>): Message {
  return {
    msgId: 'message-1',
    channelId: 'sub-task-a',
    fromRole: 'CODER',
    type: 'feedback',
    payload: { reason: 'tests_failed', secret: 'must-not-project' },
    display: 'DISPLAY MUST NEVER PROJECT',
    ts: 1,
    ...overrides,
  };
}

describe('DerivedChannelContextBuilder', () => {
  it('default-denies cross-project/task/non-participant data and applies payload allowlists', () => {
    const task = {
      ...createInitialAppState('task-a', 'goal', 'project-a'),
      messages: [
        message({ msgId: 'main-chat', channelId: 'main', type: 'chat' }),
        message({
          msgId: 'main-summary',
          channelId: 'main',
          type: 'announce',
          payload: {
            kind: 'channel_summary',
            channelId: 'sub-task-a',
            threadId: 'thread-a',
            summary: { conclusion: 'Done' },
            secret: 'no',
          },
        }),
        message({ msgId: 'sub-feedback' }),
        message({ msgId: 'forged', fromRole: 'TESTER' }),
        message({ msgId: 'unknown', type: 'chat', payload: { secret: 'no' } }),
      ],
    };

    const tester = new DerivedChannelContextBuilder().build(project, task, 'TESTER');
    expect(tester).toHaveLength(1);
    expect(tester[0]?.entries.map((entry) => entry.ref.msgId)).toEqual(['main-summary']);

    const coder = new DerivedChannelContextBuilder().build(project, task, 'CODER');
    expect(coder).toHaveLength(2);
    expect(coder[1]?.entries).toEqual([
      {
        ref: { taskId: 'task-a', msgId: 'sub-feedback' },
        fromRole: 'CODER',
        type: 'feedback',
        content: { reason: 'tests_failed' },
      },
      {
        ref: { taskId: 'task-a', msgId: 'unknown' },
        fromRole: 'CODER',
        type: 'chat',
      },
    ]);
    expect(JSON.stringify(coder)).not.toContain('DISPLAY MUST NEVER PROJECT');
    expect(JSON.stringify(coder)).not.toContain('must-not-project');
    expect(() =>
      new DerivedChannelContextBuilder().build(
        project,
        { ...task, projectId: 'project-b' },
        'CODER',
      ),
    ).toThrow('project identity mismatch');
  });

  it('keeps newest structured entries and reduces older facts to ordered refs under 4000 chars', () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message({
        msgId: `message-${index}`,
        payload: { reason: `reason-${index}-${'x'.repeat(900)}` },
        ts: index,
      }),
    );
    const task = { ...createInitialAppState('task-a', 'goal', 'project-a'), messages };
    const context = new DerivedChannelContextBuilder().build(project, task, 'CODER')[1];

    expect(context).toBeDefined();
    expect(
      JSON.stringify({
        entries: context?.entries,
        omittedRefs: context?.omittedRefs,
        omittedRefCount: context?.omittedRefCount,
      }).length,
    ).toBeLessThanOrEqual(CHANNEL_CONTEXT_BUDGET_CHARS);
    expect(context?.entries.at(-1)?.ref.msgId).toBe('message-7');
    expect(context?.omittedRefs.map((ref) => ref.msgId)).toEqual([
      'message-0',
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(context?.omittedRefCount).toBe(5);
  });

  it('bounds omitted refs together with entries and reports refs dropped by the budget', () => {
    const messages = Array.from({ length: 500 }, (_, index) =>
      message({ msgId: `message-${String(index).padStart(4, '0')}`, payload: {}, ts: index }),
    );
    const task = { ...createInitialAppState('task-a', 'goal', 'project-a'), messages };
    const context = new DerivedChannelContextBuilder().build(project, task, 'CODER')[1];

    expect(context).toBeDefined();
    expect(
      JSON.stringify({
        entries: context?.entries,
        omittedRefs: context?.omittedRefs,
        omittedRefCount: context?.omittedRefCount,
      }).length,
    ).toBeLessThanOrEqual(CHANNEL_CONTEXT_BUDGET_CHARS);
    expect(context?.omittedRefCount).toBe(500 - (context?.entries.length ?? 0));
    expect(context?.omittedRefs.length).toBeLessThan(context?.omittedRefCount ?? 0);
    const omittedIds = context?.omittedRefs.map((ref) => ref.msgId) ?? [];
    expect(omittedIds).toEqual([...omittedIds].sort());
  });

  it('returns defensive copies', () => {
    const task = {
      ...createInitialAppState('task-a', 'goal', 'project-a'),
      messages: [message({ msgId: 'sub-feedback' })],
    };
    const context = new DerivedChannelContextBuilder().build(project, task, 'CODER');
    const content = context[1]?.entries[0]?.content;
    if (content === undefined) throw new Error('expected projected content');
    content.reason = 'mutated';
    expect(task.messages[0]?.payload.reason).toBe('tests_failed');
  });
});
