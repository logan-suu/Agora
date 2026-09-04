import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState } from '@agora/core-domain';
import type { TraceReader, TraceSnapshot } from '@agora/runtime-executor';
import { JsonTaskStateStore } from '@agora/runtime-state';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchTraceSnapshot } from '../src/app/chat-model';
import { createGetTrace } from '../src/server/trace-handlers';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(snapshot?: TraceSnapshot) {
  const root = await mkdtemp(join(tmpdir(), 'agora-trace-handler-'));
  roots.push(root);
  const store = new JsonTaskStateStore(root);
  await store.initialize(
    { projectId: 'project-a', taskId: 'task-a' },
    createInitialAppState('task-a', 'trace task', 'project-a'),
  );
  const calls: unknown[] = [];
  const reader: TraceReader = {
    read: async (scope, options) => {
      calls.push({ scope, options });
      return (
        snapshot ?? {
          projectId: scope.projectId,
          taskId: scope.taskId,
          omittedEventCount: 0,
          sessions: [],
        }
      );
    },
  };
  return { handler: createGetTrace(store, reader), calls };
}

describe('GET /api/traces', () => {
  it('checks task existence before returning a bounded trace snapshot', async () => {
    const { handler, calls } = await fixture();

    const response = await handler(
      new Request('http://localhost/api/traces?projectId=project-a&taskId=task-a&maxEvents=42'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: 'project-a',
      taskId: 'task-a',
      omittedEventCount: 0,
      sessions: [],
    });
    expect(calls).toEqual([
      {
        scope: { projectId: 'project-a', taskId: 'task-a' },
        options: { maxEvents: 42 },
      },
    ]);
  });

  it('returns 404 without reading trace storage when the task is missing', async () => {
    const { handler, calls } = await fixture();

    const response = await handler(
      new Request('http://localhost/api/traces?projectId=project-a&taskId=missing'),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each([
    'projectId=../escape&taskId=task-a',
    'projectId=project-a&taskId=task-a&maxEvents=0',
    'projectId=project-a&taskId=task-a&maxEvents=2001',
    'projectId=project-a&taskId=task-a&maxEvents=1.5',
  ])('rejects an unsafe query before reading storage: %s', async (query) => {
    const { handler, calls } = await fixture();

    const response = await handler(new Request(`http://localhost/api/traces?${query}`));

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('fetchTraceSnapshot', () => {
  it('accepts the structural public DTO', async () => {
    const snapshot: TraceSnapshot = {
      projectId: 'project-a',
      taskId: 'task-a',
      omittedEventCount: 3,
      sessions: [
        {
          sessionId: 'session-1',
          role: 'CODER',
          createdAt: 1,
          turns: [
            {
              turn: 0,
              startedAt: 2,
              endedAt: 5,
              status: 'completed',
              steps: [
                {
                  step: 0,
                  startedAt: 2,
                  endedAt: 5,
                  status: 'completed',
                  tools: [
                    {
                      callId: 'call-1',
                      name: 'fs_read',
                      startedAt: 3,
                      endedAt: 4,
                      status: 'succeeded',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const fetcher = async () => Response.json(snapshot);

    await expect(fetchTraceSnapshot('/api/traces', fetcher)).resolves.toEqual(snapshot);
  });

  it('rejects malformed or content-bearing trace rows', async () => {
    const fetcher = async () =>
      Response.json({
        projectId: 'project-a',
        taskId: 'task-a',
        omittedEventCount: 0,
        sessions: [
          {
            sessionId: 'session-1',
            role: 'CODER',
            createdAt: 1,
            turns: [],
            prompt: 'must never be accepted',
          },
        ],
      });

    await expect(fetchTraceSnapshot('/api/traces', fetcher)).rejects.toThrow(
      /invalid trace response/i,
    );
  });
});
