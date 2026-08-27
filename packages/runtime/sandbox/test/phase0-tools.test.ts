import { Context } from '@deepseek-ai/cordis';
import { CallId } from '@deepseek-ai/dsh-llm/brand';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { LocalTempSandbox } from '../src/local-temp-sandbox';
import { createPhase0Tools } from '../src/phase0-tools';
import type { SandboxManager } from '../src/sandbox-manager';
import type { Worktree } from '../src/types';

// R11 说明：本文件用真实 LocalTempSandbox（真实临时目录 + 真实子进程）与真实
// ToolRuntime 注册执行工具，无 mock——工具本身即被测对象，用真实依赖验证行为。
// 唯一例外：无真实 LLM（工具不依赖 LLM），无需注入适配器。

interface ToolsFixture {
  sandbox: SandboxManager;
  worktree: Worktree;
  ctx: Context;
  dispose(): Promise<void>;
}

async function toolsFixture(): Promise<ToolsFixture> {
  const sandbox = new LocalTempSandbox();
  const worktree = await sandbox.createWorktree('tools-test', 'shared');
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  const tools = createPhase0Tools({ sandbox, getWorktree: async () => worktree });
  for (const tool of tools) {
    ctx.tools.register(tool);
  }
  return {
    sandbox,
    worktree,
    ctx,
    dispose: async () => {
      await sandbox.teardown('tools-test');
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

describe('Phase 0 function tools (createPhase0Tools)', () => {
  it('registers wire-safe names (fs_read/fs_write/sandbox_run) matching the RoleSpec whitelist projection', async () => {
    const fixture = await toolsFixture();
    try {
      const names = fixture.ctx.tools
        .schemas()
        .map((schema) => schema.name)
        .sort();
      expect(names).toEqual(['fs_read', 'fs_write', 'sandbox_run']);
    } finally {
      await fixture.dispose();
    }
  });

  it('fs.write persists a file that fs.read retrieves (real temp dir)', async () => {
    const fixture = await toolsFixture();
    try {
      const written = await exec(fixture.ctx, 'fs_write', {
        path: 'lru-cache.ts',
        content: 'export class LruCache {}',
      });
      expect(written.isError).toBe(false);

      const read = await exec(fixture.ctx, 'fs_read', { path: 'lru-cache.ts' });
      expect(read.isError).toBe(false);
      if (!read.isError) {
        expect(read.value).toBe('export class LruCache {}');
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects fs.write paths that escape the worktree root (decision R7)', async () => {
    const fixture = await toolsFixture();
    try {
      const result = await exec(fixture.ctx, 'fs_write', {
        path: '../escape.ts',
        content: 'x',
      });
      expect(result.isError).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('sandbox.run executes a real child process and captures exit code and stdout', async () => {
    const fixture = await toolsFixture();
    try {
      const result = await exec(fixture.ctx, 'sandbox_run', {
        cmd: 'node -e "console.log(41 + 1)"',
      });
      expect(result.isError).toBe(false);
      if (!result.isError) {
        const value = result.value as { exitCode: number; stdout: string };
        expect(value.exitCode).toBe(0);
        expect(value.stdout).toContain('42');
      }
    } finally {
      await fixture.dispose();
    }
  });
});
