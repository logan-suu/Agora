import { WorktreeRegistry } from '@agora/tools-fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { LintService } from './lint-service';
import { WorktreeLintService } from './lint-service';

/** Options for building a lint-server; dependencies are injectable for tests. */
export interface LintServerOptions {
  /** Worktree allowlist; defaults to a fresh empty registry. */
  registry?: WorktreeRegistry;
  /** Lint service; defaults to a {@link WorktreeLintService} over `registry`. */
  service?: LintService;
}

/**
 * Build an MCP lint-server (spec §6 `lint-server`).
 *
 * Registers the `check` tool against the given service and registry.
 * Transport-agnostic: call {@link serveLintServer} to connect it.
 */
export function createLintServer(options: LintServerOptions = {}): McpServer {
  const registry = options.registry ?? new WorktreeRegistry();
  const service = options.service ?? new WorktreeLintService(registry);
  const server = new McpServer({ name: 'lint-server', version: '0.0.0' });

  server.registerTool(
    'check',
    {
      description:
        'Lint files inside a registered worktree with Biome and return the structured issue list [] (empty = clean).',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Worktree-relative paths to lint; defaults to the whole worktree.'),
      },
    },
    async ({ worktree, paths }) => {
      try {
        const issues = await service.check(worktree, paths ?? []);
        return textResult(JSON.stringify(issues));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Connect a built lint-server to a transport (the injection point).
 *
 * When `transport` is omitted it defaults to {@link StdioServerTransport} — the
 * phase default (decision R9: swap the body, keep the interface). Pass a
 * Streamable HTTP transport to switch without touching the tool definitions.
 */
export async function serveLintServer(
  transport?: Transport,
  options: LintServerOptions = {},
): Promise<McpServer> {
  const server = createLintServer(options);
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
