/** Closed Leader grant policy. Broker permission never grants child-process networking. */
import { type LocalDownloadPolicy, validateDownloadPolicy } from './local-download-policy';
import { localRecordHash } from './local-registry-records';

export interface LocalGrantPolicy {
  version: 'seatbelt-apfs-v1';
  actions: ('read' | 'edit' | 'run' | 'generate' | 'install')[];
  toolchain: { manifestHash: string };
  network: { mode: 'disabled' } | LocalDownloadPolicy;
  outputs: { kind: 'private-per-operation' };
}
export function validateLocalGrantPolicy(value: LocalGrantPolicy) {
  localRecordHash(value);
  if (
    Object.keys(value).sort().join(',') !== 'actions,network,outputs,toolchain,version' ||
    value.version !== 'seatbelt-apfs-v1' ||
    !Array.isArray(value.actions) ||
    !value.actions.length ||
    new Set(value.actions).size !== value.actions.length ||
    value.actions.some((a) => !['read', 'edit', 'run', 'generate', 'install'].includes(a)) ||
    Object.keys(value.toolchain).join(',') !== 'manifestHash' ||
    !/^[a-f0-9]{64}$/.test(value.toolchain.manifestHash) ||
    localRecordHash(value.outputs) !== localRecordHash({ kind: 'private-per-operation' })
  )
    throw Error('invalid_workspace_policy');
  if (value.network.mode === 'disabled') {
    if (localRecordHash(value.network) !== localRecordHash({ mode: 'disabled' }))
      throw Error('invalid_workspace_policy');
  } else {
    validateDownloadPolicy(value.network);
  }
  return structuredClone(value);
}
