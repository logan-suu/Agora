import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { SandboxManager } from './sandbox-manager';
import type { Worktree } from './types';

/**
 * Worktree resolver injected into every Phase 0 tool.
 *
 * Phase 0 shares ONE worktree per task across roles (single-worker degenerate
 * slice, spec §9): the Coder writes code and the Tester must run tests in the
 * same directory. The composition root owns the resolution; Phase 1+ replaces
 * it with per-role worktrees behind the same SandboxManager port (decision R9).
 */
export interface Phase0ToolDeps {
  sandbox: SandboxManager;
  getWorktree(): Promise<Worktree>;
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * Map a RoleSpec tool name (MCP-style, e.g. "fs.read") to its wire-safe form.
 * The DeepSeek function-calling API rejects dots in tool names
 * (pattern `^[a-zA-Z0-9_-]+$`), so Phase 0 registers tools under underscore
 * forms while RoleSpec.tools keeps the spec §6 MCP names for Phase 1 alignment.
 */
export function wireToolName(specName: string): string {
  return specName.replaceAll('.', '_');
}

/**
 * Phase 0 function tools (decision D5 / spec §9: "工具只接 fs + sandbox.run").
 *
 * Plain in-process function tools — NOT MCP servers (those land in Phase 1 via
 * `packages/tools/*`). Tool names are the wire-safe projections of the
 * RoleSpec.tools whitelist entries (`fs.read` → `fs_read`); the composition
 * root filters per role via {@link wireToolName}. Every path is confined to
 * the sandbox worktree root by the SandboxManager (decision R7).
 */
export function createPhase0Tools(deps: Phase0ToolDeps): ToolDefinition[] {
  return [defineFsRead(deps), defineFsWrite(deps), defineSandboxRun(deps)];
}

function defineFsRead(deps: Phase0ToolDeps): ToolDefinition {
  return defineTool({
    name: wireToolName('fs.read'),
    description:
      'Read a file from the sandbox worktree. The path is relative to the worktree root (e.g. "lru-cache.ts") and must not escape it.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File path relative to the worktree root.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args) {
      const worktree = await deps.getWorktree();
      return deps.sandbox.read(worktree, args.path);
    },
  });
}

function defineFsWrite(deps: Phase0ToolDeps): ToolDefinition {
  return defineTool({
    name: wireToolName('fs.write'),
    description:
      'Write a file inside the sandbox worktree. The path is relative to the worktree root (e.g. "lru-cache.ts") and must not escape it; intermediate directories are created as needed.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File path relative to the worktree root.',
      },
      content: { type: 'string', required: true, description: 'Full file content to write.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args) {
      const worktree = await deps.getWorktree();
      await deps.sandbox.write(worktree, args.path, args.content);
      return { ok: true, path: args.path };
    },
  });
}

function defineSandboxRun(deps: Phase0ToolDeps): ToolDefinition {
  return defineTool({
    name: wireToolName('sandbox.run'),
    description:
      'Run a shell command inside the sandbox worktree (default timeout 30s, decision R7). Use it to execute tests, e.g. `node --test lru-cache.test.ts` or `node lru-cache.test.ts`.',
    parameters: {
      cmd: {
        type: 'string',
        required: true,
        description: 'Shell command to run inside the worktree.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Optional timeout override in milliseconds (default 30000).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args) {
      const worktree = await deps.getWorktree();
      const result = await deps.sandbox.run(worktree, args.cmd, args.timeoutMs);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  });
}
