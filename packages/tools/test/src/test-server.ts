import { WorktreeRegistry } from '@agora/tools-fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { TestService } from './test-service';
import { WorktreeTestService } from './test-service';

/** Options for building a test-server; dependencies are injectable for tests. */
export interface TestServerOptions {
  /** Worktree allowlist; defaults to a fresh empty registry. */
  registry?: WorktreeRegistry;
  /** Test service; defaults to a {@link WorktreeTestService} over `registry`. */
  service?: TestService;
}

/**
 * Build an MCP test-server (spec §6 `test-server`).
 *
 * Registers the `run` tool against the given service and registry.
 * Transport-agnostic: call {@link serveTestServer} to connect it.
 */
export function createTestServer(options: TestServerOptions = {}): McpServer {
  const registry = options.registry ?? new WorktreeRegistry();
  const service = options.service ?? new WorktreeTestService(registry);
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });

  server.registerTool(
    'run',
    {
      description:
        'Run a test command (e.g. `node --test`) inside a registered worktree and return structured results aligned with State.testResults.',
      inputSchema: {
        worktree: z.string().describe('Registered worktree root path.'),
        cmd: z.string().describe('Test command to run (spawned with shell in the worktree root).'),
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Timeout in ms; defaults to 30000.'),
      },
    },
    async ({ worktree, cmd, timeout }) => {
      try {
        const result = await service.run(worktree, cmd, timeout);
        return textResult(JSON.stringify(result));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Connect a built test-server to a transport (the injection point).
 *
 * When `transport` is omitted it defaults to {@link StdioServerTransport} — the
 * Phase 1 default (decision R9: swap the body, keep the interface). Pass a
 * Streamable HTTP transport to switch without touching the tool definitions.
 */
export async function serveTestServer(
  transport?: Transport,
  options: TestServerOptions = {},
): Promise<McpServer> {
  const server = createTestServer(options);
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
