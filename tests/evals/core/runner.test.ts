import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgoraEvalTask } from './contracts';
import { runEvalTask } from './runner';

const roots: string[] = [];
const task: AgoraEvalTask = {
  schemaVersion: 1,
  id: 'phase6/isolation',
  version: '1.0.0',
  source: 'agora',
  profiles: ['deterministic'],
  goal: 'Prove isolated eval writes.',
  repository: { fixture: 'tests/evals/fixtures/isolation', revision: 'fixture-v1' },
  expectedOutcome: { assertions: ['run.completed'] },
  expectedInvariants: ['process.isolated-data-root', 'safety.no-product-write'],
  limits: { maxIterations: 8, maxDurationMs: 30_000, maxModelCalls: 8, maxToolCalls: 16 },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Eval runner', () => {
  it('writes an atomic, hashed result beneath evals without touching product data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-eval-runner-'));
    roots.push(root);
    const evalRoot = join(root, '.data', 'evals');
    const productSentinel = join(root, '.data', 'projects', 'sentinel.txt');
    await mkdir(join(root, '.data', 'projects'), { recursive: true });
    writeFileSync(productSentinel, 'unchanged');

    const result = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 1,
      evalRoot,
      runnerVersion: 'phase6-v1',
      systemVariant: 'multi-agent-projection',
      modelConfig: { provider: 'scripted', model: 'fixture-v1', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async ({ dataRoot, workspaceRoot }) => {
        const canonicalRoot = await realpath(evalRoot);
        expect(dataRoot.startsWith(canonicalRoot)).toBe(true);
        expect(workspaceRoot.startsWith(canonicalRoot)).toBe(true);
        return {
          assertions: { 'run.completed': true },
          invariants: {
            'process.isolated-data-root': true,
            'safety.no-product-write': true,
          },
          efficiency: { iterations: 1, modelCalls: 1, toolCalls: 2 },
        };
      },
    });

    expect(readFileSync(productSentinel, 'utf8')).toBe('unchanged');
    expect(result.lifecycle).toBe('final');
    expect(result.overallStatus).toBe('pass');
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(result.efficiency.inputTokens).toBe('unknown');
    expect(result.artifactRefs).toContainEqual(
      expect.objectContaining({
        path: 'observation.json',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(existsSync(join(evalRoot, result.runId, 'result.json'))).toBe(true);
    expect(existsSync(join(evalRoot, result.runId, 'result.json.tmp'))).toBe(false);
  });

  it('records failures and rejects unsupported profiles or non-evals roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-eval-failure-'));
    roots.push(root);
    await expect(
      runEvalTask({
        task,
        profile: 'model',
        attempt: 1,
        evalRoot: join(root, '.data', 'evals'),
        runnerVersion: 'phase6-v1',
        systemVariant: 'x',
        modelConfig: { provider: 'deepseek', model: 'x', parameters: {} },
        environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
        execute: async () => ({}),
      }),
    ).rejects.toThrow('profile');

    await expect(
      runEvalTask({
        task,
        profile: 'deterministic',
        attempt: 1,
        evalRoot: join(root, '.data', 'projects'),
        runnerVersion: 'phase6-v1',
        systemVariant: 'x',
        modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
        environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
        execute: async () => ({}),
      }),
    ).rejects.toThrow('evals');

    const failed = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 2,
      evalRoot: join(root, '.data', 'evals'),
      runnerVersion: 'phase6-v1',
      systemVariant: 'x',
      modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async () => {
        throw new Error('scenario broke');
      },
    });
    expect(failed.failure).toEqual({ category: 'execution', detail: 'scenario broke' });
    expect(failed.overallStatus).toBe('fail');
    expect(failed.checks.some((check) => check.status === 'unknown')).toBe(true);

    const unobserved = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 3,
      evalRoot: join(root, '.data', 'evals'),
      runnerVersion: 'phase6-v2',
      systemVariant: 'x',
      modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async () => ({
        efficiency: { iterations: 1, modelCalls: 0, toolCalls: 0 },
      }),
    });
    expect(unobserved.failure).toBeUndefined();
    expect(unobserved.overallStatus).toBe('fail');
  });

  it('writes provisional evidence before cleanup and derives the final cleanup result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-eval-cleanup-'));
    roots.push(root);
    const evalRoot = join(root, '.data', 'evals');
    let provisionalLifecycle: string | undefined;

    const result = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 1,
      evalRoot,
      runnerVersion: 'phase6-v2',
      systemVariant: 'x',
      modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async ({ runRoot, registerCleanup }) => {
        registerCleanup(async () => {
          provisionalLifecycle = JSON.parse(
            readFileSync(join(runRoot, 'result.json'), 'utf8'),
          ).lifecycle;
          return { invariants: { 'safety.no-product-write': true } };
        });
        return {
          assertions: { 'run.completed': true },
          invariants: { 'process.isolated-data-root': true },
          efficiency: { iterations: 1, modelCalls: 0, toolCalls: 0 },
        };
      },
    });

    expect(provisionalLifecycle).toBe('provisional');
    expect(result.lifecycle).toBe('final');
    expect(result.overallStatus).toBe('pass');
    expect(result.checks.find((check) => check.id === 'safety.no-product-write')?.status).toBe(
      'pass',
    );
  });

  it('fails closed on cleanup failure and iteration-budget overflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-eval-budget-'));
    roots.push(root);
    const result = await runEvalTask({
      task,
      profile: 'deterministic',
      attempt: 1,
      evalRoot: join(root, '.data', 'evals'),
      runnerVersion: 'phase6-v2',
      systemVariant: 'x',
      modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async ({ registerCleanup }) => {
        registerCleanup(async () => {
          throw new Error('teardown broke');
        });
        return {
          assertions: { 'run.completed': true },
          invariants: {
            'process.isolated-data-root': true,
            'safety.no-product-write': true,
          },
          efficiency: { iterations: 9, modelCalls: 0, toolCalls: 0 },
        };
      },
    });

    expect(result.failure).toEqual({ category: 'cleanup', detail: 'teardown broke' });
    expect(result.overallStatus).toBe('fail');
    expect(result.checks.find((check) => check.id === 'efficiency.iterations')?.status).toBe(
      'fail',
    );
  });

  it('rejects nested and symlinked eval roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-eval-root-'));
    roots.push(root);
    const baseOptions = {
      task,
      profile: 'deterministic' as const,
      attempt: 1,
      runnerVersion: 'phase6-v2',
      systemVariant: 'x',
      modelConfig: { provider: 'scripted', model: 'x', parameters: {} },
      environment: { sandbox: 'test', imageOrRuntime: 'node-test', platform: process.platform },
      execute: async () => ({}),
    };
    await expect(
      runEvalTask({ ...baseOptions, evalRoot: join(root, '.data', 'nested', 'evals') }),
    ).rejects.toThrow('.data/evals');

    const target = join(root, 'target');
    const linkedRoot = join(root, '.data', 'evals');
    await mkdir(target, { recursive: true });
    await mkdir(join(root, '.data'), { recursive: true });
    await symlink(target, linkedRoot);
    await expect(runEvalTask({ ...baseOptions, evalRoot: linkedRoot })).rejects.toThrow('symbolic');
  });
});
