import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeTestService } from '../src/test-service';

/**
 * G5: real execution — every case spawns a real child process (`node --test`)
 * inside a real temp worktree and parses its real TAP output. No mocks.
 */
describe('WorktreeTestService', () => {
  let root: string;
  let registry: WorktreeRegistry;
  let service: WorktreeTestService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agora-test-svc-'));
    registry = new WorktreeRegistry();
    registry.register(root);
    service = new WorktreeTestService(registry);
  });

  afterEach(() => {
    registry.unregister(root);
  });

  it('reports a passing run with correct counts', async () => {
    writeFileSync(
      join(root, 'pass.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('one', () => assert.equal(1, 1));\ntest('two', () => assert.equal(2, 2));\n",
    );
    const result = await service.run(root, 'node --test pass.test.mjs');
    expect(result.passed).toBe(true);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('reports a failing run with file/line/message extracted from TAP', async () => {
    writeFileSync(
      join(root, 'fail.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => assert.equal(1, 2, 'nope'));\n",
    );
    const result = await service.run(root, 'node --test fail.test.mjs');
    expect(result.passed).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(1);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure?.test).toBe('boom');
    expect(failure?.line).toBe(3);
    expect(failure?.file).toBe(realpathSync(join(root, 'fail.test.mjs')));
    expect(failure?.message).toContain('nope');
  });

  it('reports a timeout as a non-passing result without fabricating a green pass', async () => {
    const result = await service.run(root, 'node -e "setTimeout(()=>{}, 100000)"', 100);
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.test).toBe('(timeout)');
    expect(result.failures[0]?.message).toContain('timed out');
  });

  it('kills the whole process group on timeout so grandchildren do not leak', async () => {
    const script = [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 100000)"]);',
      "writeFileSync('grand.pid', String(g.pid));",
      'setTimeout(() => {}, 100000);',
    ].join('\n');
    writeFileSync(join(root, 'spawn-grand.mjs'), script);
    const result = await service.run(root, 'node spawn-grand.mjs', 300);
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.test).toBe('(timeout)');

    const grandPid = Number(readFileSync(join(root, 'grand.pid'), 'utf8'));
    expect(Number.isInteger(grandPid)).toBe(true);
    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(grandPid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  });

  it('falls back to exit code for non-TAP output and never reports green on failure', async () => {
    const result = await service.run(root, 'node -e "console.log(\'boom\'); process.exit(3)"');
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.test).toBe('(exit 3)');
    expect(result.failures[0]?.message).toContain('boom');
  });

  it('rejects an unregistered worktree root', async () => {
    const other = mkdtempSync(join(tmpdir(), 'agora-other-'));
    try {
      await expect(service.run(other, 'node --test')).rejects.toThrow(/not registered/);
    } finally {
      registry.unregister(other);
    }
  });

  it('runs with the worktree root as cwd (command sees files there)', async () => {
    writeFileSync(join(root, 'cwd.test.mjs'), "import test from 'node:test';test('x',()=>{});\n");
    const result = await service.run(root, 'node --test cwd.test.mjs');
    expect(result.passed).toBe(true);
    expect(result.total).toBe(1);
  });
});
