// A faulting authority and mutation sentinels isolate ordering before native
// launch. Real grant/command integration remains covered by Phase 12 tests.
import { expect, it, vi } from 'vitest';
import { LocalWorkspaceCommands } from '../src/local-workspace-commands';

it('rejects a startup-budget failure before publishing any command or input', async () => {
  const mutation = vi.fn(() => {
    throw Error('unexpected_mutation');
  });
  const authority = { commandStartupWindow: vi.fn().mockRejectedValue(Error('authority_closed')) };
  const receiver = {
    authority,
    files: { assertQuiescent: vi.fn().mockResolvedValue(undefined) },
    objects: { put: mutation, bindReference: mutation },
    journal: { reserve: mutation },
    inputs: { materialize: mutation },
  };
  const call = {
    projectId: 'p',
    taskId: 't',
    workspaceId: 'w',
    workerId: 'coder',
    actionId: 'command',
    grantRevision: 1,
    writerEpoch: 1,
  };
  const run = Reflect.get(LocalWorkspaceCommands.prototype, 'run');
  await expect(Reflect.apply(run, receiver, [call, { toolId: 'node' }])).rejects.toThrow(
    'authority_closed',
  );
  expect(mutation).not.toHaveBeenCalled();
  expect(authority.commandStartupWindow).toHaveBeenCalledWith(call);
});
