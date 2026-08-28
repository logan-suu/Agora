import type { SandboxManager, Worktree } from '@agora/runtime-sandbox';
import { createSandboxRunTool, wireToolName } from '@agora/runtime-sandbox';
import { createFsServer, WorktreeRegistry } from '@agora/tools-fs';
import { createGitServer } from '@agora/tools-git';
import { createTestServer } from '@agora/tools-test';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue, ParameterSchemaSpec, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ResolvedRoleTools, resolveRoleTools } from './loader';

/**
 * MCP → Harness tool bridge (task 1.5, spec §0/§2/§6).
 *
 * The Phase 1 fs/test/git MCP servers are connected in-process (one
 * `McpServer` + one `Client` over an {@link InMemoryTransport} linked pair) and
 * each MCP tool is wrapped as a Harness {@link ToolDefinition}. Model-visible
 * tool names stay the Phase 0 wire forms (`fs_read`, `test_run`,
 * `git_apply_patch` — wire-safe, user-confirmed), while RoleSpec.tools keeps
 * the spec §6 MCP-style logical names; the bridge owns the mapping.
 *
 * Two model-facing conveniences:
 * - The MCP servers take a registered `worktree` root argument; the bridge
 *   injects it from the composition-root resolver, so the model keeps working
 *   with worktree-relative paths exactly like Phase 0.
 * - Cooperative timeout: fs/git calls declare `timeoutMs` (R7 default 30s)
 *   and the execute body forwards `exec.signal`, so the Harness timeout policy
 *   (`@deepseek-ai/dsh-tool-call-timeout-policy`, loaded by the executor) can
 *   abort them. `test_run`/`sandbox_run` deliberately omit `timeoutMs`: their
 *   underlying services enforce R7 themselves and return a structured
 *   `timedOut` result the model can act on (double deadlines would mask it).
 */
export interface ToolCatalogOptions {
  /** Shared worktree allowlist; defaults to a fresh empty registry. */
  registry?: WorktreeRegistry;
  /** Sandbox manager backing the function tool `sandbox_run`. */
  sandbox: SandboxManager;
  /** Resolves the worktree the model's relative paths are resolved against. */
  getWorktree(): Promise<Worktree>;
  /** Git main repo path; when omitted the git service lazily creates a temp main repo. */
  mainRepoPath?: string;
  /** Default cooperative timeout for MCP-backed fs/git calls (default 30000, R7). */
  mcpTimeoutMs?: number;
}

/** The bridged tool catalog a composition root loads roles from (task 1.5). */
export interface ToolCatalog {
  /** Every bridged tool definition, for registration on an executor's ctx. */
  all(): readonly ToolDefinition[];
  /** Resolve one logical tool name to its bridged definition(s), if implemented. */
  lookup(logicalName: string): readonly ToolDefinition[] | undefined;
  /** Expand a RoleSpec.tools whitelist (see {@link resolveRoleTools}). */
  resolve(tools: readonly string[]): ResolvedRoleTools;
  /** Close the in-process MCP clients and servers. */
  dispose(): Promise<void>;
}

/** Default cooperative timeout for MCP-backed tools without an inner timeout (R7). */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/**
 * Logical → wire-name expansion table (RoleSpec.tools → model-visible tools).
 *
 * One logical entry may grant several wire tools (`git` is a capability
 * group), and two entries may grant the same wire tool (`sandbox.applyPatch`
 * aliases `git.applyPatch` — the Phase 0 sandbox patch concept is realized by
 * the git worktree in Phase 1). `lint` is intentionally absent (DEF-005): the
 * loader reports it `unavailable` instead of granting nothing silently.
 */
const LOGICAL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'fs.read': [wireToolName('fs.read')],
  'fs.write': [wireToolName('fs.write')],
  'fs.list': [wireToolName('fs.list')],
  'test.run': [wireToolName('test.run')],
  git: [
    wireToolName('git.createWorktree'),
    wireToolName('git.applyPatch'),
    wireToolName('git.diff'),
    wireToolName('git.merge'),
  ],
  'sandbox.applyPatch': [wireToolName('git.applyPatch')],
  'sandbox.run': [wireToolName('sandbox.run')],
};

/** One concrete MCP-backed tool wrapped into a Harness ToolDefinition. */
interface McpToolSpec {
  /** Wire-safe model-visible name (e.g. `fs_read`). */
  readonly wireName: string;
  /** MCP server owning the tool. */
  readonly server: 'fs' | 'test' | 'git';
  /** Tool name inside the MCP server (e.g. `read`). */
  readonly mcpTool: string;
  /** Inject the sandbox worktree root as the MCP `worktree` argument. */
  readonly needsWorktree: boolean;
  /** Cooperative timeout in ms; omit to leave the inner service's own timeout authoritative. */
  readonly timeoutMs?: number;
  readonly description: string;
  readonly parameters: ParameterSchemaSpec;
}

/** MCP tool → Harness tool wiring for fs-server (1.1), test-server (1.2), git-server (1.3). */
const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    wireName: wireToolName('fs.read'),
    server: 'fs',
    mcpTool: 'read',
    needsWorktree: true,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'Read a file from the sandbox worktree. The path is relative to the worktree root (e.g. "lru-cache.ts") and must not escape it. Optionally read a character range.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File path relative to the worktree root.',
      },
      range: {
        type: 'object',
        description: 'Optional 0-based character range [start, end).',
        properties: {
          start: { type: 'integer', required: true, description: 'Inclusive start offset.' },
          end: { type: 'integer', description: 'Exclusive end offset.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    wireName: wireToolName('fs.write'),
    server: 'fs',
    mcpTool: 'write',
    needsWorktree: true,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
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
  },
  {
    wireName: wireToolName('fs.list'),
    server: 'fs',
    mcpTool: 'list',
    needsWorktree: true,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'List files inside the sandbox worktree whose relative path matches a glob pattern (e.g. `**/*.ts`).',
    parameters: {
      glob: {
        type: 'string',
        required: true,
        description: 'Glob pattern relative to the worktree root.',
      },
    },
  },
  {
    wireName: wireToolName('test.run'),
    server: 'test',
    mcpTool: 'run',
    needsWorktree: true,
    description:
      'Run a test command inside the sandbox worktree and return structured results {passed,total,failed,failures}. The worktree service enforces its own timeout (default 30s, R7).',
    parameters: {
      cmd: {
        type: 'string',
        required: true,
        description: 'Test command to run inside the worktree.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Optional timeout override in milliseconds (default 30000).',
      },
    },
  },
  {
    wireName: wireToolName('git.createWorktree'),
    server: 'git',
    mcpTool: 'createWorktree',
    needsWorktree: false,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'Create a linked git worktree with a new branch from the main repo and register it. Returns the worktree path and branch name.',
    parameters: {
      taskId: {
        type: 'string',
        required: true,
        description: 'Task id used to name the worktree directory.',
      },
      name: {
        type: 'string',
        required: true,
        description: 'Branch name (must be git-ref-safe).',
      },
    },
  },
  {
    wireName: wireToolName('git.applyPatch'),
    server: 'git',
    mcpTool: 'applyPatch',
    needsWorktree: true,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'Apply a unified diff patch inside the sandbox worktree, stage all changes, and commit. Returns the new commit id.',
    parameters: {
      patch: {
        type: 'string',
        required: true,
        description: 'Unified diff patch text to apply.',
      },
    },
  },
  {
    wireName: wireToolName('git.diff'),
    server: 'git',
    mcpTool: 'diff',
    needsWorktree: true,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'Return the unified diff of the sandbox worktree: working-tree changes vs HEAD when `ref` is omitted, else vs the given ref.',
    parameters: {
      ref: {
        type: 'string',
        description: 'Optional ref to diff against (defaults to HEAD).',
      },
    },
  },
  {
    wireName: wireToolName('git.merge'),
    server: 'git',
    mcpTool: 'merge',
    needsWorktree: false,
    timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
    description:
      'Merge a branch into a base branch in the main repo. Returns {ok:true} on a clean merge, or {ok:false, conflicts} when the target branch is checked out by a linked worktree or the merge has conflicts.',
    parameters: {
      base: {
        type: 'string',
        required: true,
        description: 'Base branch to check out and merge into.',
      },
      branch: { type: 'string', required: true, description: 'Branch to merge into the base.' },
    },
  },
];

/** One bridged server: the McpServer and its in-process Client. */
interface BridgedServer {
  readonly name: 'fs' | 'test' | 'git';
  readonly server: McpServer;
  readonly client: Client;
}

/** Build a catalog over the three Phase 1 MCP servers + the sandbox function tool. */
export async function createToolCatalog(options: ToolCatalogOptions): Promise<ToolCatalog> {
  const registry = options.registry ?? new WorktreeRegistry();
  const fsServer = createFsServer({ registry });
  const testServer = createTestServer({ registry });
  const gitServer = createGitServer({
    registry,
    ...(options.mainRepoPath === undefined ? {} : { mainRepoPath: options.mainRepoPath }),
  });
  const servers: readonly BridgedServer[] = await Promise.all([
    connectServer('fs', fsServer),
    connectServer('test', testServer),
    connectServer('git', gitServer),
  ]);
  const byServer = new Map(servers.map((server) => [server.name, server]));

  const byWire = new Map<string, ToolDefinition>();
  for (const spec of MCP_TOOLS) {
    const server = byServer.get(spec.server);
    if (server === undefined) {
      throw new Error(`createToolCatalog: no bridged server for "${spec.server}"`);
    }
    byWire.set(spec.wireName, bridgeMcpTool(server, spec, options));
  }
  // Function-backed sandbox.run: no MCP server exists (packages/tools/sandbox is
  // a stub); the SandboxManager enforces R7 (30s, SIGKILL) and returns a
  // structured timedOut the model can retry on.
  byWire.set(
    wireToolName('sandbox.run'),
    createSandboxRunTool({ sandbox: options.sandbox, getWorktree: options.getWorktree }),
  );

  const allDefinitions = [...byWire.values()];
  const lookup = (logicalName: string): readonly ToolDefinition[] | undefined => {
    const wireNames = LOGICAL_GROUPS[logicalName];
    if (wireNames === undefined) return undefined;
    const definitions = wireNames
      .map((wireName) => byWire.get(wireName))
      .filter((definition): definition is ToolDefinition => definition !== undefined);
    return definitions.length === 0 ? undefined : definitions;
  };

  return {
    all: () => allDefinitions,
    lookup,
    resolve: (tools) => resolveRoleTools(tools, lookup),
    dispose: async () => {
      await Promise.all(
        servers.flatMap((server) => [server.client.close(), server.server.close()]),
      );
    },
  };
}

/** Connect one McpServer to an in-process Client over a linked InMemoryTransport pair. */
async function connectServer(
  name: 'fs' | 'test' | 'git',
  server: McpServer,
): Promise<BridgedServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${name}-client`, version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { name, server, client };
}

/** Wrap one MCP tool as a Harness ToolDefinition (worktree injected, signal forwarded). */
function bridgeMcpTool(
  server: BridgedServer,
  spec: McpToolSpec,
  deps: ToolCatalogOptions,
): ToolDefinition {
  return {
    name: spec.wireName,
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    output: {
      // Unconstrained JSON root (JsonSchemaNode: omit `type` for any JSON value).
      schema: {},
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args, exec) {
      const mcpArgs: Record<string, unknown> = { ...(args as Record<string, unknown>) };
      if (spec.needsWorktree) {
        mcpArgs.worktree = (await deps.getWorktree()).path;
      }
      // Forward the Harness abort signal into the MCP RequestOptions so the SDK
      // cancels the in-flight request (and, over the in-process transport,
      // propagates `extra.signal` to the server handler). The server handlers
      // check that signal between mutating steps (e.g. git apply → add → commit),
      // so a TOOL_TIMEOUT never lets a late commit land unseen.
      const outcome = await raceAbort(exec.signal, () =>
        server.client.callTool({ name: spec.mcpTool, arguments: mcpArgs }, undefined, {
          signal: exec.signal,
        }),
      );
      // Settle gracefully on abort (never reject): the Harness timeout policy
      // (tools/execute wrapper) detects its own deadline and substitutes the
      // TOOL_TIMEOUT result; the registry canonicalizes caller cancellation.
      if (outcome.aborted) return { aborted: true };
      const result = outcome.value;
      const content = contentResultOf(result);
      if (content !== undefined && content.isError === true) throw new Error(mcpError(result));
      return looseParse(mcpText(result));
    },
  };
}

/** Race a task against `signal`, settling gracefully (not rejecting) on abort. */
function raceAbort<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    task().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The resolved shape of `client.callTool` in MCP SDK 1.30: the classic
 * `{content, isError}` result, or the task-based `{toolResult}` variant.
 * Agora's fs/test/git servers always return the classic shape.
 */
type CallToolOutcome = CallToolResult | { readonly toolResult: unknown };

/** The classic content-result branch of a {@link CallToolOutcome}, if present. */
function contentResultOf(result: CallToolOutcome): CallToolResult | undefined {
  if ('content' in result && Array.isArray(result.content)) return result as CallToolResult;
  return undefined;
}

/** First text block of an MCP CallToolResult, JSON-serialized as a fallback. */
function mcpText(result: CallToolOutcome): string {
  const content = contentResultOf(result);
  if (content !== undefined) {
    for (const block of content.content) {
      if (block.type === 'text') return block.text;
    }
    return JSON.stringify(content.content);
  }
  return JSON.stringify(result.toolResult);
}

/** The underlying error message from an MCP error result (strips the `error: ` prefix). */
function mcpError(result: CallToolOutcome): string {
  const text = mcpText(result);
  return text.startsWith('error: ') ? text.slice('error: '.length) : text;
}

/** Parse a tool result as JSON when possible, else keep the raw text. */
function looseParse(text: string): unknown {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}
