// Promise gates control live operation scheduling; no native closure is mocked
// or claimed. These tests verify the actual trusted queue's activity view.
import { expect, it } from 'vitest';
import {
  localWorkspaceOperationActivity,
  serializeWorkspaceOperation,
} from '../src/local-workspace-operation';

const scope = { projectId: 'operation-project', taskId: 'task', workspaceId: 'workspace' };
it('shows both an active and queued operation until each caller actually settles', async () => {
  let release = () => {},
    started = () => {};
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    beginning = new Promise<void>((r) => {
      started = r;
    });
  const first = serializeWorkspaceOperation(scope, async () => {
    started();
    await gate;
  });
  await beginning;
  const second = serializeWorkspaceOperation(scope, async () => {
    throw Error('operation_failed');
  });
  const observed = second.catch((e) => e.message);
  try {
    expect(localWorkspaceOperationActivity(scope)).toEqual([
      { workspaceId: 'workspace', active: 1, queued: 1 },
    ]);
    expect(localWorkspaceOperationActivity({ ...scope, taskId: 'other' })).toEqual([]);
  } finally {
    release();
    await first;
  }
  expect(await observed).toBe('operation_failed');
  expect(localWorkspaceOperationActivity(scope)).toEqual([]);
});
it('does not treat an unrelated workspace operation as the selected physical writer', async () => {
  let release = () => {},
    started = () => {};
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    beginning = new Promise<void>((r) => {
      started = r;
    });
  const other = serializeWorkspaceOperation({ ...scope, workspaceId: 'independent' }, async () => {
    started();
    await gate;
  });
  await beginning;
  try {
    expect(localWorkspaceOperationActivity(scope)).toEqual([
      { workspaceId: 'independent', active: 1, queued: 0 },
    ]);
  } finally {
    release();
    await other;
  }
});
