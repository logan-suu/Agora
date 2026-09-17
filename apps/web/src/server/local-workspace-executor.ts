/** Explicit composition seam for a local CODER. The ordinary production
 * task factory remains gated until complete local task acceptance. */
import type { RoleSpec } from '@agora/core-domain';
import { localWorkspaceRole } from '@agora/roles-definitions';
import { HarnessExecutor, type HarnessExecutorOptions } from '@agora/runtime-executor';
import type { WorkspaceControlSession, WorkspaceWorkerSession } from '@agora/runtime-sandbox';
import { createLocalWorkspaceCatalog } from '@agora/tools-bridge';

export function createLocalControlExecutor(input: {
  spec: RoleSpec;
  session: Pick<WorkspaceControlSession, 'kind' | 'sessionId'>;
  options: Omit<
    HarnessExecutorOptions,
    'tools' | 'allowTools' | 'readTestResults' | 'readSubtaskStatus'
  >;
}) {
  if (
    !['PM', 'COORDINATOR'].includes(input.spec.role) ||
    input.spec.executor !== 'harness' ||
    input.session.kind !== 'control'
  )
    throw Error('local_control_role_required');
  const executor = new HarnessExecutor(
    { ...input.spec, tools: [] },
    { ...input.options, tools: [], allowTools: [] },
  );
  return { executor, dispose: () => executor.dispose() };
}

export async function createLocalWorkspaceExecutor(input: {
  spec: RoleSpec;
  session: Pick<WorkspaceWorkerSession, 'workspace' | 'sessionId' | 'tools'>;
  options: Omit<
    HarnessExecutorOptions,
    'tools' | 'allowTools' | 'readTestResults' | 'readSubtaskStatus'
  >;
}) {
  const spec = localWorkspaceRole(input.spec);
  if (input.session.workspace.purpose !== (spec.role === 'CODER' ? 'coding' : 'validation'))
    throw Error('local_workspace_role_binding_mismatch');
  const capabilities = spec.tools.map((tool) => {
    if (tool === 'workspace.read') return 'read' as const;
    if (tool === 'workspace.apply') return 'apply' as const;
    if (tool === 'workspace.run') return 'run' as const;
    throw Error('invalid_local_tool_grant');
  });
  const catalog = await createLocalWorkspaceCatalog({
    port: input.session.tools,
    sessionId: input.session.sessionId,
    capabilities,
  });
  try {
    const resolved = catalog.resolve(spec.tools);
    if (resolved.unavailable.length) throw Error('local_tool_unavailable');
    const executor = new HarnessExecutor(spec, {
      ...input.options,
      tools: resolved.definitions,
      allowTools: resolved.allowNames,
    });
    return {
      executor,
      dispose: async () => {
        try {
          await executor.dispose();
        } finally {
          await catalog.dispose();
        }
      },
    };
  } catch (error) {
    await catalog.dispose();
    throw error;
  }
}

/** Kept for the existing explicit CODER acceptance entry. */
export const createLocalCoderExecutor: typeof createLocalWorkspaceExecutor = (input) => {
  if (input.spec.role !== 'CODER') throw Error('local_coder_role_required');
  return createLocalWorkspaceExecutor(input);
};
