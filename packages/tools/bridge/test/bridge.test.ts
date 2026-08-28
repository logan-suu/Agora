import { PHASE0_ROSTER } from '@agora/core-domain';
import type { Worktree } from '@agora/runtime-sandbox';
import { LocalTempSandbox } from '@agora/runtime-sandbox';
import { WorktreeRegistry } from '@agora/tools-fs';
import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { createToolCatalog, DEFAULT_MCP_TIMEOUT_MS } from '../src/mcp-bridge';

// R11 说明：本文件用真实依赖验证桥接（无 mock）——真实 LocalTempSandbox
// （真实临时目录 + 真实子进程）、真实 MCP fs/test/git server（InMemoryTransport
// client-server round-trip）、真实 git 二进制、真实 node --test。工具本身即被测
// 对象，故用真实 ToolRuntime 注册执行。唯一例外：无真实 LLM（工具不依赖 LLM）。

async function bridgeFixture(): Promise<{
  sandbox: LocalTempSandbox;
  worktree: Worktree;
  setWorktree(next: Worktree): void;
  catalog: Awaited<ReturnType<typeof createToolCatalog>>;
  ctx: Context;
  dispose(): Promise<void>;
}> {
  const sandbox = new LocalTempSandbox();
  const worktree = await sandbox.createWorktree('bridge-test', 'shared');
  const registry = new WorktreeRegistry();
  registry.register(worktree.path);
  let current = worktree;
  const catalog = await createToolCatalog({
    registry,
    sandbox,
    getWorktree: async () => current,
  });
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  for (const tool of catalog.all()) {
    ctx.tools.register(tool);
  }
  return {
    sandbox,
    worktree,
    setWorktree: (next) => {
      current = next;
    },
    catalog,
    ctx,
    dispose: async () => {
      await catalog.dispose();
      await sandbox.teardown('bridge-test');
    },
  };
}

function exec(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`call-${name}-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  });
}

/** The canonical value a bridged tool resolved (or the thrown error message). */
async function toolValue(ctx: Context, name: string, args: unknown): Promise<unknown> {
  const result = await exec(ctx, name, args);
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.value;
}

describe('createToolCatalog (MCP → Harness bridge, task 1.5)', () => {
  it('registers the 9 wire-safe tools covering fs/test/git servers + sandbox.run', async () => {
    const fixture = await bridgeFixture();
    try {
      const names = fixture.catalog
        .all()
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual([
        'fs_list',
        'fs_read',
        'fs_write',
        'git_applyPatch',
        'git_createWorktree',
        'git_diff',
        'git_merge',
        'sandbox_run',
        'test_run',
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('declares cooperative timeouts (R7) on fs/git but not on test_run/sandbox_run', async () => {
    const fixture = await bridgeFixture();
    try {
      const byName = new Map(fixture.catalog.all().map((tool) => [tool.name, tool]));
      expect(byName.get('fs_read')?.timeoutMs).toBe(DEFAULT_MCP_TIMEOUT_MS);
      expect(byName.get('git_applyPatch')?.timeoutMs).toBe(DEFAULT_MCP_TIMEOUT_MS);
      expect(byName.get('test_run')?.timeoutMs).toBeUndefined();
      expect(byName.get('sandbox_run')?.timeoutMs).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the worktree out of the model-visible parameters (bridge injects it)', async () => {
    const fixture = await bridgeFixture();
    try {
      const byName = new Map(fixture.catalog.all().map((tool) => [tool.name, tool]));
      const readParams = byName.get('fs_read')?.parameters as Record<string, unknown>;
      expect(Object.keys(readParams)).toEqual(['path', 'range']);
      expect('worktree' in readParams).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('round-trips a real file through the MCP fs-server (write → read → list)', async () => {
    const fixture = await bridgeFixture();
    try {
      await toolValue(fixture.ctx, 'fs_write', {
        path: 'notes/a.txt',
        content: 'hello from the bridge',
      });
      const content = (await toolValue(fixture.ctx, 'fs_read', {
        path: 'notes/a.txt',
      })) as string;
      expect(content).toBe('hello from the bridge');
      const listing = (await toolValue(fixture.ctx, 'fs_list', {
        glob: '**/*.txt',
      })) as { paths: string[] };
      expect(listing.paths).toContain('notes/a.txt');
    } finally {
      await fixture.dispose();
    }
  });

  it('runs a real node --test suite through the MCP test-server', async () => {
    const fixture = await bridgeFixture();
    try {
      await toolValue(fixture.ctx, 'fs_write', {
        path: 'sum.test.js',
        content:
          "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('1 + 2 = 3', () => assert.strictEqual(1 + 2, 3));\n",
      });
      const run = (await toolValue(fixture.ctx, 'test_run', {
        cmd: 'node --test sum.test.js',
      })) as { passed: boolean; total: number; failed: number };
      expect(run.passed).toBe(true);
      expect(run.total).toBe(1);
      expect(run.failed).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('creates a git worktree, applies a patch, and diffs it (real git binary)', async () => {
    const fixture = await bridgeFixture();
    try {
      const created = (await toolValue(fixture.ctx, 'git_createWorktree', {
        taskId: 'bridge-git',
        name: 'feat-bridge',
      })) as { path: string; branch: string };
      expect(created.branch).toBe('feat-bridge');
      // Point the resolver at the git worktree so fs/git tools share it.
      fixture.setWorktree({ path: created.path, branch: created.branch });

      await toolValue(fixture.ctx, 'fs_write', {
        path: 'hello.txt',
        content: 'hello from a git worktree',
      });
      const patched = (await toolValue(fixture.ctx, 'git_applyPatch', {
        patch: [
          'diff --git a/patched.txt b/patched.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/patched.txt',
          '@@ -0,0 +1 @@',
          '+patched content',
          '',
        ].join('\n'),
      })) as { commitId: string };
      expect(patched.commitId).toMatch(/^[0-9a-f]{40}$/);

      const diff = (await toolValue(fixture.ctx, 'git_diff', {
        ref: 'HEAD~1',
      })) as string;
      expect(diff).toContain('patched.txt');
    } finally {
      await fixture.dispose();
    }
  });

  it('runs a shell command through the sandbox_run function tool', async () => {
    const fixture = await bridgeFixture();
    try {
      const run = (await toolValue(fixture.ctx, 'sandbox_run', {
        cmd: 'node -e "console.log(41 + 1)"',
      })) as { exitCode: number; stdout: string };
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('42');
    } finally {
      await fixture.dispose();
    }
  });

  it('resolves the CODER whitelist against the real catalog (git expands, lint unavailable)', async () => {
    const fixture = await bridgeFixture();
    try {
      const coder = PHASE0_ROSTER.find((entry) => entry.role === 'CODER');
      const tester = PHASE0_ROSTER.find((entry) => entry.role === 'TESTER');
      if (coder === undefined || tester === undefined) throw new Error('roster missing roles');
      const coderResolved = fixture.catalog.resolve(coder.tools);
      expect(coderResolved.allowNames).toEqual([
        'fs_read',
        'fs_write',
        'sandbox_run',
        'git_createWorktree',
        'git_applyPatch',
        'git_diff',
        'git_merge',
      ]);
      expect(coderResolved.unavailable).toEqual(['lint']);
      const testerResolved = fixture.catalog.resolve(tester.tools);
      expect(testerResolved.unavailable).toEqual([]);
      expect(testerResolved.allowNames).toContain('sandbox_run');
    } finally {
      await fixture.dispose();
    }
  });
});
