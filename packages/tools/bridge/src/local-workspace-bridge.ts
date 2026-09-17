/** Separate catalog: local workers cannot accidentally resolve legacy writes. */
import { createHash } from 'node:crypto';
import type { BoundWorkspaceTools } from '@agora/runtime-sandbox';
import { createWorkspaceServer, type WorkspaceToolCapability } from '@agora/tools-fs';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveRoleTools } from './loader';
import type { ToolCatalog } from './mcp-bridge';

export async function createLocalWorkspaceCatalog(options: {
  port: BoundWorkspaceTools;
  sessionId: string;
  capabilities: readonly WorkspaceToolCapability[];
}): Promise<ToolCatalog> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(options.sessionId))
    throw Error('invalid_workspace_session');
  const sessionId = options.sessionId;
  const server = createWorkspaceServer(options.port, options.capabilities);
  const client = new Client({ name: 'workspace-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const listed = await client.listTools();
    const definitions: ToolDefinition[] = listed.tools.map((tool) => {
      const parameters = structuredClone(tool.inputSchema);
      delete parameters.properties?.actionId;
      parameters.required = parameters.required?.filter((key) => key !== 'actionId') ?? [];
      return {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters,
        output: {
          schema: {},
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.signal.aborted) throw Error('workspace_call_cancelled');
          if (
            !args ||
            typeof args !== 'object' ||
            Array.isArray(args) ||
            Object.keys(args).some((key) => !Object.hasOwn(parameters.properties ?? {}, key))
          )
            throw Error('invalid_workspace_arguments');
          const actionId = `tool:${createHash('sha256')
            .update(JSON.stringify({ sessionId, callId: exec.callId }))
            .digest('hex')}`;
          // Do not race an in-flight mutation against cancellation. The bounded
          // native service settles its durable effects before this tool returns.
          const response = await client.callTool(
            { name: tool.name, arguments: { ...args, actionId } },
            undefined,
            { timeout: 600000 },
          );
          if (!('content' in response) || !Array.isArray(response.content))
            throw Error('invalid_workspace_tool_result');
          const text = response.content
            .map((item) => (item.type === 'text' ? item.text : ''))
            .join('');
          if (response.isError) throw Error(text);
          return JSON.parse(text);
        },
      };
    });
    const lookup = (logicalName: string) => {
      const found = definitions.find((tool) => tool.name === logicalName.replace('.', '_'));
      return found ? [found] : undefined;
    };
    return {
      all: () => definitions,
      lookup,
      resolve: (tools) => resolveRoleTools(tools, lookup),
      dispose: async () => {
        await Promise.all([client.close(), server.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()]);
    throw error;
  }
}
