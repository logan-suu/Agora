// External command outcomes are simulated to cover missing software without changing the host.
// The production launcher and real subprocess path are also verified separately.
import { expect, it, vi } from 'vitest';
import { checkDependencies } from '../scripts/local-diagnostics.mjs';

function commands(overrides: Record<string, string | Error> = {}) {
  return vi.fn(async (tool: string, args: string[]) => {
    const key = [tool, ...args].join(' ');
    const value = overrides[key] ?? (tool === 'pnpm' ? '9.15.9' : 'available');
    if (value instanceof Error) throw value;
    return value;
  });
}

it('reports all missing tools and a wrong Node version together with repair steps', async () => {
  const run = commands({
    'pnpm --version': new Error('private diagnostic output'),
    'git --version': new Error('missing'),
    '/usr/bin/clang --version': new Error('missing'),
    'docker --version': new Error('missing'),
  });
  const error = await checkDependencies('/repo', {
    platform: 'darwin',
    nodeVersion: '22.0.0',
    run,
  }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  for (const text of [
    'Node.js 24',
    'npm install --global pnpm@9.15.9',
    'Git',
    'xcode-select --install',
    'Docker CLI',
    'docs/install-macos.md',
  ]) {
    expect(message).toContain(text);
  }
  expect(message).not.toContain('private diagnostic output');
  expect(run.mock.calls.some(([, args]) => args[0] === 'info')).toBe(false);
});

it('distinguishes an installed Docker CLI from an unreachable engine', async () => {
  const run = commands({ 'docker info --format {{.ServerVersion}}': new Error('socket denied') });
  await expect(
    checkDependencies('/repo', { platform: 'darwin', nodeVersion: '24.1.0', run }),
  ).rejects.toThrow('Docker engine is not reachable');
  expect(run).toHaveBeenCalledWith('docker', ['info', '--format', '{{.ServerVersion}}'], '/repo');
});

it('does not hide a wrong pnpm version behind another missing dependency', async () => {
  const run = commands({ 'pnpm --version': '10.0.0', 'git --version': new Error('missing') });
  const error = await checkDependencies('/repo', {
    platform: 'darwin',
    nodeVersion: '24.1.0',
    run,
  }).catch((e: Error) => e);
  expect((error as Error).message).toContain('pnpm 9.15.9');
  expect((error as Error).message).toContain('Git');
});

it('accepts a compatible host without running installation commands', async () => {
  const run = commands();
  await expect(
    checkDependencies('/repo', { platform: 'darwin', nodeVersion: '24.1.0', run }),
  ).resolves.toBeUndefined();
  expect(run.mock.calls.map(([tool, args]) => [tool, ...args].join(' '))).toEqual([
    'pnpm --version',
    'git --version',
    '/usr/bin/clang --version',
    'docker --version',
    'docker info --format {{.ServerVersion}}',
  ]);
});

it('rejects unsupported platforms before probing host tools', async () => {
  const run = commands();
  await expect(
    checkDependencies('/repo', { platform: 'linux', nodeVersion: '24.1.0', run }),
  ).rejects.toThrow('macOS only');
  expect(run).not.toHaveBeenCalled();
});
