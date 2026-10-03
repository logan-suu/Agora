// Only external model output is scripted. Official loop/JSONL/flush and the
// read-only prefix verification are real; this is not a live-provider G5 test.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAppState, PHASE0_ROSTER } from '@agora/core-domain';
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { expect, it } from 'vitest';
import {
  HarnessExecutor,
  readHarnessLineageEvidence,
  readHarnessSafePointEvidence,
} from '../src/harness-executor';
import { project } from '../src/project';

class Replies extends LlmAdapter {
  calls = 0;
  async *stream(): AsyncIterable<StreamChunk> {
    this.calls++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'done' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function fixture(
  run: (v: {
    root: string;
    cwd: string;
    cursor: string;
    model: Replies;
    source: HarnessExecutor;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'agora-task125-session-'));
  const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
  if (!spec) throw Error('missing role');
  const model = new Replies(),
    cwd = process.cwd();
  const source = new HarnessExecutor(spec, {
    adapter: model,
    provider: 'agora',
    sessionPersistence: { root, cwd, projectId: 'project', taskId: 'task' },
  });
  try {
    await source.step({
      sessionId: 'session',
      view: project(createInitialAppState('task', 'g', 'project'), 'CODER', PHASE0_ROSTER),
    });
    const cursor = await source.saveSafePoint();
    await source.dispose();
    await run({ root, cwd, cursor, model, source });
  } finally {
    await source.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
it('verifies an official completed prefix after executor closure without another model call or log write', async () =>
  fixture(async (f) => {
    const files = await readdir(f.root, { recursive: true });
    const logs = files.filter((p) => p.endsWith('.jsonl') || p.endsWith('.zst'));
    const before = await Promise.all(logs.map((p) => readFile(join(f.root, p))));
    const result = await readHarnessSafePointEvidence(f.cursor, {
      root: f.root,
      cwd: f.cwd,
      projectId: 'project',
      taskId: 'task',
      role: 'CODER',
    });
    expect(result).toMatchObject({
      projectId: 'project',
      taskId: 'task',
      sourceSessionId: 'session',
      role: 'CODER',
    });
    expect(result.sessionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.model.calls).toBe(1);
    expect(await readdir(f.root, { recursive: true })).toEqual(files);
    expect(await Promise.all(logs.map((p) => readFile(join(f.root, p))))).toEqual(before);
  }));
it('refuses a cross-task or missing source without creating an agent or repairing storage', async () =>
  fixture(async (f) => {
    await expect(
      readHarnessSafePointEvidence(f.cursor, {
        root: f.root,
        cwd: f.cwd,
        projectId: 'project',
        taskId: 'other',
        role: 'CODER',
      }),
    ).rejects.toThrow();
    const missing = await mkdtemp(join(tmpdir(), 'agora-task125-empty-session-'));
    try {
      await expect(
        readHarnessSafePointEvidence(f.cursor, {
          root: missing,
          cwd: f.cwd,
          projectId: 'project',
          taskId: 'task',
          role: 'CODER',
        }),
      ).rejects.toThrow();
      expect(await readdir(missing)).toEqual([]);
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
    expect(f.model.calls).toBe(1);
  }));

it('proves a fresh official child has the exact closed parent seed without another model request, then preserves that lineage after a completed child turn', async () =>
  fixture(async (f) => {
    const spec = PHASE0_ROSTER.find((r) => r.role === 'CODER');
    if (!spec) throw Error('missing role');
    const child = new HarnessExecutor(spec, {
      adapter: f.model,
      provider: 'agora',
      sessionPersistence: {
        root: f.root,
        cwd: f.cwd,
        projectId: 'project',
        taskId: 'task',
        resumeSessionId: 'child',
      },
    });
    try {
      await child.loadSafePoint(f.cursor);
      const scope = {
        root: f.root,
        cwd: f.cwd,
        projectId: 'project',
        taskId: 'task',
        role: 'CODER',
      };
      const proof = await readHarnessLineageEvidence(f.cursor, 'child', scope, { fresh: true });
      expect(proof).toMatchObject({
        sourceSessionId: 'session',
        childSessionId: 'child',
        projectId: 'project',
        taskId: 'task',
        role: 'CODER',
      });
      expect(proof.seedHash).toMatch(/^[a-f0-9]{64}$/);
      expect(f.model.calls).toBe(1);
      await child.step({
        sessionId: 'child',
        view: project(
          createInitialAppState('task', 'after return', 'project'),
          'CODER',
          PHASE0_ROSTER,
        ),
      });
      await child.saveSafePoint();
      await child.dispose();
      const before = await readdir(f.root, { recursive: true });
      const historical = await readHarnessLineageEvidence(f.cursor, 'child', scope, {
        fresh: false,
      });
      expect(historical).toEqual(proof);
      expect(f.model.calls).toBe(2);
      await expect(
        readHarnessLineageEvidence(f.cursor, 'child', scope, { fresh: true }),
      ).rejects.toThrow();
      expect(await readdir(f.root, { recursive: true })).toEqual(before);
    } finally {
      await child.dispose();
    }
  }));
it('rejects missing, self, or cross-task lineage children without creating or repairing a session', async () =>
  fixture(async (f) => {
    const scope = { root: f.root, cwd: f.cwd, projectId: 'project', taskId: 'task', role: 'CODER' };
    const before = await readdir(f.root, { recursive: true });
    await expect(
      readHarnessLineageEvidence(f.cursor, 'missing', scope, { fresh: true }),
    ).rejects.toThrow();
    await expect(
      readHarnessLineageEvidence(f.cursor, 'session', scope, { fresh: true }),
    ).rejects.toThrow();
    await expect(
      readHarnessLineageEvidence(
        f.cursor,
        'missing',
        { ...scope, taskId: 'other' },
        { fresh: false },
      ),
    ).rejects.toThrow();
    expect(await readdir(f.root, { recursive: true })).toEqual(before);
    expect(f.model.calls).toBe(1);
  }));
