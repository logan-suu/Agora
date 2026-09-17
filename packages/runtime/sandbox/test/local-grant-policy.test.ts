// Pure policy checks; no registry, network or process doubles are used.
import { expect, it } from 'vitest';
import { validateLocalGrantPolicy } from '../src/local-grant-policy';

const policy = {
  version: 'seatbelt-apfs-v1' as const,
  actions: ['read', 'edit', 'install', 'run'] as ('read' | 'edit' | 'install' | 'run')[],
  toolchain: { manifestHash: 'a'.repeat(64) },
  network: {
    mode: 'brokered-https' as const,
    origins: ['https://registry.npmjs.org'],
    method: 'GET' as const,
    maxBytes: 16777216,
    timeoutMs: 30000,
    maxRedirects: 3,
  },
  outputs: { kind: 'private-per-operation' as const },
};
it('preserves a bounded explicit download policy without granting process network', () => {
  const approved = validateLocalGrantPolicy(policy);
  expect(approved).toEqual(policy);
  expect(approved).not.toBe(policy);
  expect(approved.network).not.toBe(policy.network);
});
it.each([
  { ...policy, network: { mode: 'unrestricted' } },
  { ...policy, network: { ...policy.network, origins: ['http://registry.npmjs.org'] } },
  { ...policy, network: { ...policy.network, timeoutMs: 30001 } },
  { ...policy, network: { ...policy.network, headers: { Authorization: 'fixed' } } },
  { ...policy, actions: ['read', 'install', 'install'] },
  { ...policy, actions: ['read', 'push'] },
])('rejects malformed or expanded grants %#', (input) => {
  expect(() => validateLocalGrantPolicy(input as typeof policy)).toThrow();
});
it('retains disabled-network grants and rejects extra disabled-network fields', () => {
  const disabled = { ...policy, network: { mode: 'disabled' as const } };
  expect(validateLocalGrantPolicy(disabled)).toEqual(disabled);
  expect(() =>
    validateLocalGrantPolicy({
      ...disabled,
      network: { ...disabled.network, origins: [] },
    } as typeof disabled),
  ).toThrow();
});
