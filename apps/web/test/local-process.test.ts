// Keychain native calls have a separate real OS G5; these checks exercise subprocess isolation.
import { expect, it } from 'vitest';
import { childEnvironment, controlPath } from '../scripts/local-process.mjs';

it('removes only the master key from tool environments without mutating the parent', () => {
  const source = {
    AGORA_CREDENTIALS_KEY: 'private',
    DEEPSEEK_API_KEY: 'retained-model-test-key',
    PATH: '/bin',
    NODE_ENV: 'test' as const,
  };
  const child = childEnvironment(source);
  expect(child.AGORA_CREDENTIALS_KEY).toBeUndefined();
  expect(child.DEEPSEEK_API_KEY).toBe(source.DEEPSEEK_API_KEY);
  expect(source.AGORA_CREDENTIALS_KEY).toBe('private');
});
it('uses bounded per-user control socket identities scoped to canonical data roots', () => {
  expect(controlPath('/data/a')).toBe(controlPath('/data/a'));
  expect(controlPath('/data/a')).not.toBe(controlPath('/data/b'));
  expect(Buffer.byteLength(controlPath(`/data/${'x'.repeat(300)}`))).toBeLessThan(104);
});
