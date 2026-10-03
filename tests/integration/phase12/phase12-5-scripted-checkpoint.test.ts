// Only external model output is scripted; official Harness persistence is real.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMutation, createInitialAppState } from '@agora/core-domain';
import { DEFAULT_ROSTER } from '@agora/roles-definitions';
import { project, readHarnessSafePointEvidence } from '@agora/runtime-executor';
import { expect, it } from 'vitest';
import { createScriptedLocalHarness } from './local-scripted-harness-fixture';

for (const role of ['CODER', 'REVIEWER'] as const)
  it(`persists a real closed ${role} turn and preserves scripted mutations`, async () => {
    const spec = DEFAULT_ROSTER.find((entry) => entry.role === role);
    if (!spec) throw Error('missing_fixture_role');
    const root = await mkdtemp(join(tmpdir(), 'agora-task125-scripted-'));
    let calls = 0;
    const mutations =
      role === 'REVIEWER'
        ? [
            appendMutation('reviewComments', {
              id: 'reviewed',
              kind: 'verdict',
              verdict: 'approved',
            }),
          ]
        : [];
    const scope = { root, cwd: process.cwd(), projectId: 'project', taskId: 'task' };
    const executor = createScriptedLocalHarness(spec, scope, async () => {
      calls++;
      return { kind: 'done', output: {}, reachedSafeBoundary: true, mutations };
    });
    try {
      expect(calls).toBe(0);
      const result = await executor.step({
        sessionId: `scripted-${role}`,
        view: project(createInitialAppState('task', 'g', 'project'), role, DEFAULT_ROSTER),
      });
      expect(result.kind).toBe('done');
      expect(result.reachedSafeBoundary).toBe(true);
      for (const mutation of mutations) expect(result.mutations).toContainEqual(mutation);
      const cursor = await executor.saveSafePoint();
      const files = await readdir(root, { recursive: true });
      const logs = files.filter((p) => p.endsWith('.jsonl') || p.endsWith('.zst'));
      const before = await Promise.all(logs.map((p) => readFile(join(root, p))));
      expect(await readHarnessSafePointEvidence(cursor, { ...scope, role })).toMatchObject({
        projectId: 'project',
        taskId: 'task',
        role,
        sourceSessionId: `scripted-${role}`,
      });
      expect(await executor.saveSafePoint()).toBe(cursor);
      expect(await readdir(root, { recursive: true })).toEqual(files);
      expect(await Promise.all(logs.map((p) => readFile(join(root, p))))).toEqual(before);
      expect(calls).toBe(1);
    } finally {
      await executor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
