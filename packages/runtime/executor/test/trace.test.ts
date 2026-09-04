import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';

import { projectTraceInspections, type TraceInspection } from '../src/trace';

function event(seq: number, time: number, type: string, data: unknown): SessionEvent {
  return { seq, time, type, data } as SessionEvent;
}

function inspection(
  id: string,
  role: string,
  events: SessionEvent[],
  lineage: { parentSession?: string; seedLength?: number } = {},
): TraceInspection {
  return {
    meta: {
      version: 0,
      id,
      createdAt:
        lineage.seedLength === undefined
          ? (events[0]?.time ?? 0)
          : (events[lineage.seedLength]?.time ?? events[0]?.time ?? 0),
      agentPreset: `agora-role:${role}`,
      ...lineage,
    } as SessionHeader,
    events,
  };
}

describe('projectTraceInspections', () => {
  it('projects only structural turn, step, and tool fields', () => {
    const source = inspection('source', 'CODER', [
      event(0, 10, 'turn/start', { turn: 0 }),
      event(1, 11, 'step/start', { turn: 0, step: 0 }),
      event(2, 12, 'user/message', { content: 'PROJECTION_SECRET' }),
      event(3, 13, 'tool/call', {
        turn: 0,
        step: 0,
        callId: 'call-1',
        name: 'fs_read',
        arguments: 'TOOL_ARGUMENT_SECRET',
      }),
      event(4, 14, 'tool/result', {
        turn: 0,
        step: 0,
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'TOOL_RESULT_SECRET' }],
              isError: false,
            },
          ],
        },
      }),
      event(5, 15, 'assistant/chunk', { chunk: { reasoning: 'REASONING_SECRET' } }),
      event(6, 16, 'step/end', { turn: 0, step: 0 }),
      event(7, 17, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ]);

    const trace = projectTraceInspections('project-a', 'task-a', [source]);

    expect(trace).toEqual({
      projectId: 'project-a',
      taskId: 'task-a',
      omittedEventCount: 0,
      sessions: [
        {
          sessionId: 'source',
          role: 'CODER',
          createdAt: 10,
          turns: [
            {
              turn: 0,
              startedAt: 10,
              endedAt: 17,
              status: 'completed',
              steps: [
                {
                  step: 0,
                  startedAt: 11,
                  endedAt: 16,
                  status: 'completed',
                  tools: [
                    {
                      callId: 'call-1',
                      name: 'fs_read',
                      startedAt: 13,
                      endedAt: 14,
                      status: 'succeeded',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(trace)).not.toMatch(/SECRET|arguments|message|reasoning/i);
  });

  it('keeps only child-native events and maps terminal failures', () => {
    const parentEvents = [
      event(0, 10, 'turn/start', { turn: 0 }),
      event(1, 11, 'step/start', { turn: 0, step: 0 }),
      event(2, 12, 'step/end', { turn: 0, step: 0 }),
      event(3, 13, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
    ];
    const parent = inspection('parent', 'CODER', parentEvents);
    const child = inspection(
      'child',
      'CODER',
      [
        ...parentEvents,
        event(4, 14, 'session/end-seed', {}),
        event(5, 15, 'turn/start', { turn: 1 }),
        event(6, 16, 'step/start', { turn: 1, step: 0 }),
        event(7, 17, 'tool/call', {
          turn: 1,
          step: 0,
          callId: 'call-2',
          name: 'sandbox_run',
          arguments: 'secret command',
        }),
        event(8, 18, 'tool/result', {
          turn: 1,
          step: 0,
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-2',
                content: [{ type: 'text', text: 'secret stderr' }],
                isError: true,
              },
            ],
          },
          error: { name: 'ToolError', code: 'TOOL_FAILED' },
        }),
        event(9, 19, 'step/end', { turn: 1, step: 0 }),
        event(10, 20, 'turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { message: 'secret failure', code: 'LLM_ERROR' } },
        }),
      ],
      { parentSession: 'parent', seedLength: parentEvents.length },
    );

    const trace = projectTraceInspections('project-a', 'task-a', [child, parent]);

    expect(trace.sessions.map((session) => session.sessionId)).toEqual(['parent', 'child']);
    expect(trace.sessions[1]).toMatchObject({
      parentSessionId: 'parent',
      seedLength: 4,
      turns: [
        {
          turn: 1,
          status: 'error',
          steps: [
            {
              status: 'error',
              tools: [{ status: 'failed', errorCode: 'TOOL_FAILED' }],
            },
          ],
        },
      ],
    });
    expect(trace.sessions[1]?.turns).toHaveLength(1);
    expect(JSON.stringify(trace)).not.toContain('secret');
  });

  it('omits whole oldest turns when the event budget is exceeded', () => {
    const source = inspection('source', 'TESTER', [
      event(0, 1, 'turn/start', { turn: 0 }),
      event(1, 2, 'step/start', { turn: 0, step: 0 }),
      event(2, 3, 'step/end', { turn: 0, step: 0 }),
      event(3, 4, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
      event(4, 5, 'turn/start', { turn: 1 }),
      event(5, 6, 'step/start', { turn: 1, step: 0 }),
      event(6, 7, 'step/end', { turn: 1, step: 0 }),
      event(7, 8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]);

    const trace = projectTraceInspections('project-a', 'task-a', [source], { maxEvents: 4 });

    expect(trace.omittedEventCount).toBe(4);
    expect(trace.sessions[0]?.turns.map((turn) => turn.turn)).toEqual([1]);
  });

  it('fails closed for invalid role metadata or lineage drift', () => {
    const parent = inspection('parent', 'CODER', [event(0, 1, 'turn/start', { turn: 0 })]);
    const badChild = inspection('child', 'CODER', [event(0, 1, 'turn/start', { turn: 99 })], {
      parentSession: 'parent',
      seedLength: 1,
    });
    const badRole = inspection('other', 'role with spaces', []);

    expect(() => projectTraceInspections('project-a', 'task-a', [parent, badChild])).toThrow(
      /seed prefix/i,
    );
    expect(() => projectTraceInspections('project-a', 'task-a', [badRole])).toThrow(/agentPreset/i);
  });
});
