import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE0_ROSTER } from '@agora/core-domain';
import { runOrchestration } from '@agora/core-orchestration';
import { describe, expect, it } from 'vitest';
import { resolveLiveTestModel } from '../../../../tests/helpers/live-model';
import { createPhase0Runtime } from './phase0-runtime';

/** Phase 0 G5: real Harness turns, role projection, tools, LocalTempSandbox and test artifacts. */
const liveModel = await resolveLiveTestModel();
const liveLabel = `${liveModel.options.provider}/${liveModel.model}`;

const CODE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function listCodeArtifacts(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '.git' || entry.name === 'node_modules'
        ? []
        : listCodeArtifacts(root, path);
    }
    return entry.isFile() && CODE_FILE_PATTERN.test(entry.name) ? [path] : [];
  });
}

describe(`G5 e2e: LRU cache task over live Harness provider (Phase 0 exit baseline) (${liveLabel})`, () => {
  it('runs Coordinator → CODER → TESTER to done with passing testResults and sandbox output', async () => {
    const runtime = await createPhase0Runtime({
      taskId: 'lru-1',
      goal: '实现一个带 TTL 的 LRU 缓存类，包含 get/set/delete 方法，并编写单元测试',
      ...liveModel.options,
      model: liveModel.model,
    });
    try {
      const final = await runOrchestration(runtime.initialState, {
        workerRuntime: runtime.workerRuntime,
        roster: PHASE0_ROSTER,
      });

      expect(final.phase).toBe('done');
      expect(final.testResults?.passed).toBe(true);
      expect(final.subtasks[0]?.status).toBe('done');
      const codeArtifacts = listCodeArtifacts(runtime.worktree.path);
      const testArtifacts = codeArtifacts.filter((file) => TEST_FILE_PATTERN.test(file));
      const implementationArtifacts = codeArtifacts.filter(
        (file) => !TEST_FILE_PATTERN.test(file) && !file.endsWith('.d.ts'),
      );
      expect(implementationArtifacts.length).toBeGreaterThan(0);
      expect(testArtifacts.length).toBeGreaterThan(0);
      expect(final.messages.some((m) => m.fromRole === 'CODER')).toBe(true);
      expect(final.messages.some((m) => m.fromRole === 'TESTER')).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 600_000);
});
