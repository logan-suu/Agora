import { WorktreeRegistry } from '@agora/tools-fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GitService } from './git-service';
import { WorktreeGitService } from './git-service';

/** Options for building a git-server; dependencies are injectable for tests. */
export interface GitServerOptions {
  /** Worktree allowlist; defaults to a fresh empty registry. */
  registry?: WorktreeRegistry;
  /** Git service; defaults to a {@link WorktreeGitService} over `registry`. */
  service?: GitService;
  /** Main repository path; when omitted the service lazily creates a temp main repo. */
  mainRepoPath?: string;
}

/**
 * Build an MCP git-server (spec §6 `git-server`).
 *
 * Registers the `applyPatch` / `diff` / `createWorktree` / `merge` tools against
 * the given service and registry. Transport-agnostic: call
 * {@link serveGitServer} to connect it.
 */
export function createGitServer(options: GitServerOptions = {}): McpServer {
  const registry = options.registry ?? new WorktreeRegistry();
  const service = options.service ?? new WorktreeGitService(registry, options.mainRepoPath);
  const server = new McpServer({ name: 'git-server', version: '0.0.0' });

  server.registerTool(
    'applyPatch',
    {
      description:
        'Apply a unified diff patch inside a registered worktree, stage all changes, and commit. Returns the new commit id.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        patch: z.string().describe('Unified diff patch text to apply.'),
      },
    },
    async ({ worktree, patch }) => {
      try {
        const commitId = await service.applyPatch(worktree, patch);
        return textResult(JSON.stringify({ commitId }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'diff',
    {
      description:
        'Return the unified diff of a registered worktree: working-tree changes vs HEAD when `ref` is omitted, else vs the given ref.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        ref: z.string().optional().describe('Optional ref to diff against (defaults to HEAD).'),
      },
    },
    async ({ worktree, ref }) => {
      try {
        const diff = await service.diff(worktree, ref);
        return textResult(diff);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'createWorktree',
    {
      description:
        'Create a linked git worktree with a new branch from the main repo and register it. Returns the worktree path and branch name.',
      inputSchema: {
        taskId: z.string().describe('Task id used to name the worktree directory.'),
        name: z.string().describe('Branch name (must be git-ref-safe).'),
      },
    },
    async ({ taskId, name }) => {
      try {
        const result = await service.createWorktree(taskId, name);
        return textResult(JSON.stringify(result));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'merge',
    {
      description:
        'Merge a branch into a base branch in the main repo. Returns {ok:true} on a clean merge, or {ok:false, conflicts} when the target branch is checked out by a linked worktree or the merge has conflicts.',
      inputSchema: {
        base: z.string().describe('Base branch to check out and merge into.'),
        branch: z.string().describe('Branch to merge into the base.'),
      },
    },
    async ({ base, branch }) => {
      try {
        const result = await service.merge(base, branch);
        return textResult(JSON.stringify(result));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Connect a built git-server to a transport (the injection point).
 *
 * When `transport` is omitted it defaults to {@link StdioServerTransport} — the
 * Phase 1 default (decision R9: swap the body, keep the interface). Pass a
 * Streamable HTTP transport to switch without touching the tool definitions.
 */
export async function serveGitServer(
  transport?: Transport,
  options: GitServerOptions = {},
): Promise<McpServer> {
  const server = createGitServer(options);
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}

/** Wrap a value as a plain-text MCP tool result. */
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap an error as an MCP tool error result (`isError: true`). */
function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
