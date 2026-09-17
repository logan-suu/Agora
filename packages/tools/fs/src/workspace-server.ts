/** In-process versioned workspace tools. Authority comes from the bound port,
 * never from arguments. This server must not be exposed over public transports. */
import type { BoundWorkspaceTools } from '@agora/runtime-sandbox';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export type WorkspaceToolCapability = 'read' | 'apply' | 'run';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff);
      }) && value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
const fileVersion = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('absent'),
    parentIdentity: z.string().min(1).max(1024),
    name: z.string().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal('regular'),
    identity: z.string().min(1).max(1024),
    sha256: hash,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    executable: z.boolean(),
    metadataHash: hash,
  }),
]);
const version = z.strictObject({
  kind: z.literal('files'),
  manifestId: z.string().min(1).max(128),
  manifestHash: hash,
});
const entry = z.strictObject({
  path: relative,
  version: fileVersion,
  readReceiptId: z.string().regex(/^read:[a-f0-9]{64}$/),
});
const actionId = z.string().regex(/^tool:[a-f0-9]{64}$/);
const result = async (run: () => Promise<unknown>): Promise<CallToolResult> => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] };
  } catch (error) {
    const message =
      error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
        ? error.message
        : 'workspace_tool_failed';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
};
export function createWorkspaceServer(
  port: BoundWorkspaceTools,
  capabilities: readonly WorkspaceToolCapability[],
) {
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((c) => !['read', 'apply', 'run'].includes(c))
  )
    throw Error('invalid_workspace_capabilities');
  const server = new McpServer({ name: 'workspace-server', version: '1.0.0' });
  if (capabilities.includes('read'))
    server.registerTool(
      'workspace_read',
      {
        description:
          'Read one relative file with its exact version and readReceiptId. Omit path to capture the current file manifest and inputVersion for a command. Excluded secret paths are never readable.',
        inputSchema: z.strictObject({
          actionId,
          path: relative.optional(),
          commandReceiptId: z
            .string()
            .regex(/^run:[a-f0-9]{64}$/)
            .optional(),
        }),
      },
      ({ actionId, path, commandReceiptId }) =>
        result(async () => {
          if (commandReceiptId) {
            if (!path || !port.generated) throw Error('workspace_generation_unavailable');
            const generated = await port.generated(actionId, commandReceiptId, path);
            if (generated.content.length > 1024 * 1024) throw Error('workspace_tool_content_limit');
            return {
              ...generated,
              content: generated.content.toString('base64'),
              encoding: 'base64',
            };
          }
          if (path === undefined) return port.inspect(actionId);
          const read = await port.read(actionId, path);
          if (read.kind === 'absent') return read;
          if (read.content.length > 1024 * 1024) throw Error('workspace_tool_content_limit');
          // A byte-preserving response avoids silently normalizing binary files.
          const text = read.content.toString('utf8');
          const utf8 = Buffer.from(text).equals(read.content);
          return {
            ...read,
            content: utf8 ? text : read.content.toString('base64'),
            encoding: utf8 ? 'utf8' : 'base64',
          };
        }),
    );
  if (capabilities.includes('apply'))
    server.registerTool(
      'workspace_apply',
      {
        description:
          'Apply up to 64 versioned file puts. Every target needs the expected version and original readReceiptId. Include additional unchanged read dependencies. Conflicts require rereading; partial results require Leader attention.',
        inputSchema: z.strictObject({
          actionId,
          changes: z
            .array(
              z.strictObject({
                path: relative,
                expected: fileVersion,
                readReceiptId: z.string().regex(/^read:[a-f0-9]{64}$/),
                content: z.string().max(22369624),
                encoding: z.enum(['utf8', 'base64']),
              }),
            )
            .min(1)
            .max(64),
          dependencies: z.array(entry).max(64),
        }),
      },
      ({ actionId, changes, dependencies }) =>
        result(() => port.apply(actionId, changes, dependencies)),
    );
  if (capabilities.includes('run'))
    server.registerTool(
      'workspace_run',
      {
        description:
          'Run approved managed Node against an exact file inputVersion from workspace_read. Source is read-only; only a fresh private output directory is writable. Use @input/path or @output/path arguments. Network is disabled. A nonzero exit or needsAttention is not a passed test.',
        inputSchema: z.strictObject({
          actionId,
          toolId: z.enum(['node', 'node-generate', 'pnpm-install']),
          argv: z.array(z.string().max(8192)).max(128),
          inputVersion: version,
          timeoutMs: z.number().int().min(1).max(30000).default(30000),
        }),
      },
      ({ actionId, ...request }) =>
        result(() =>
          port.run(actionId, {
            ...request,
            outputRoot: 'private-per-operation',
            networkGrantId: null,
          }),
        ),
    );
  return server;
}
