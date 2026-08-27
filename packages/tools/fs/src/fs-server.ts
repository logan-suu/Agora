import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FsService } from './fs-service';
import { WorktreeFsService } from './fs-service';
import { WorktreeRegistry } from './worktree-registry';

/** Options for building an fs-server; dependencies are injectable for tests. */
export interface FsServerOptions {
  /** Worktree allowlist; defaults to a fresh empty registry. */
  registry?: WorktreeRegistry;
  /** File service; defaults to a {@link WorktreeFsService} over `registry`. */
  service?: FsService;
}

/**
 * Build an MCP fs-server (spec §6 `fs-server`).
 *
 * Registers the `read` / `write` / `list` tools against the given service and
 * registry. Transport-agnostic: call {@link serveFsServer} to connect it.
 */
export function createFsServer(options: FsServerOptions = {}): McpServer {
  const registry = options.registry ?? new WorktreeRegistry();
  const service = options.service ?? new WorktreeFsService(registry);
  const server = new McpServer({ name: 'fs-server', version: '0.0.0' });

  server.registerTool(
    'read',
    {
      description:
        'Read a file from a registered worktree. `path` is relative to the worktree root and must not escape it. Optionally read a character range.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        path: z.string().describe('File path relative to the worktree root.'),
        range: z
          .object({
            start: z.number().int().min(0).describe('Inclusive start offset.'),
            end: z.number().int().min(0).optional().describe('Exclusive end offset.'),
          })
          .optional()
          .describe('Optional 0-based character range [start, end).'),
      },
    },
    async ({ worktree, path, range }) => {
      try {
        return textResult(service.read(worktree, path, range));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'write',
    {
      description:
        'Write a file inside a registered worktree. `path` is relative to the worktree root and must not escape it; intermediate directories are created as needed.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        path: z.string().describe('File path relative to the worktree root.'),
        content: z.string().describe('Full file content to write.'),
      },
    },
    async ({ worktree, path, content }) => {
      try {
        service.write(worktree, path, content);
        return textResult(JSON.stringify({ ok: true, path }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list',
    {
      description:
        'List files inside a registered worktree whose relative path matches a glob pattern (e.g. `**/*.ts`). The worktree must be a registered root.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        glob: z.string().describe('Glob pattern relative to the worktree root.'),
      },
    },
    async ({ worktree, glob }) => {
      try {
        return textResult(JSON.stringify({ paths: service.list(worktree, glob) }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Connect a built fs-server to an arbitrary transport (the injection point).
 *
 * Default Phase 1 wiring uses stdio; a Streamable HTTP transport can be swapped
 * in later without touching the tool definitions (decision R9: swap the body,
 * keep the interface).
 */
export async function serveFsServer(
  transport: Transport,
  options: FsServerOptions = {},
): Promise<McpServer> {
  const server = createFsServer(options);
  await server.connect(transport);
  return server;
}

export { WorktreeRegistry } from './worktree-registry';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
