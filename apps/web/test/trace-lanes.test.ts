import { describe, expect, it } from 'vitest';
import type { TraceSnapshotView } from '../src/app/chat-model';
import { traceLanes } from '../src/app/trace-lanes';

describe('trace lineage lanes', () => {
  it('keeps same-role roots separate and places native Fork events on the parent lane', () => {
    const snapshot: TraceSnapshotView = {
      projectId: 'p',
      taskId: 't',
      omittedEventCount: 7,
      sessions: [
        {
          sessionId: 'a',
          role: 'CODER',
          createdAt: 100,
          turns: [{ turn: 0, startedAt: 100, endedAt: 200, status: 'completed', steps: [] }],
        },
        {
          sessionId: 'b',
          role: 'CODER',
          createdAt: 120,
          turns: [{ turn: 0, startedAt: 120, endedAt: 240, status: 'completed', steps: [] }],
        },
        {
          sessionId: 'a-child',
          parentSessionId: 'a',
          seedLength: 9,
          role: 'CODER',
          createdAt: 220,
          turns: [
            {
              turn: 1,
              startedAt: 220,
              status: 'running',
              steps: [{ step: 0, startedAt: 225, status: 'running', tools: [] }],
            },
          ],
        },
      ],
    };
    const result = traceLanes(snapshot, 300);
    expect(
      result.lanes.map((lane) => [
        lane.rootSessionId,
        lane.sessions.map((session) => session.sessionId),
      ]),
    ).toEqual([
      ['a', ['a', 'a-child']],
      ['b', ['b']],
    ]);
    expect(result.start).toBe(100);
    expect(result.end).toBe(300);
    expect(result.running).toBe(true);
    expect(snapshot.omittedEventCount).toBe(7);
  });
  it('does not invent a same-role parent when a bounded snapshot omits that session', () => {
    const result = traceLanes(
      {
        projectId: 'p',
        taskId: 't',
        omittedEventCount: 3,
        sessions: [
          {
            sessionId: 'child',
            parentSessionId: 'omitted-parent',
            role: 'CODER',
            createdAt: 1,
            turns: [],
          },
        ],
      },
      100,
    );
    expect(result.lanes[0]?.rootSessionId).toBe('omitted-parent');
    expect(result.lanes[0]?.parentOmitted).toBe(true);
  });
});
