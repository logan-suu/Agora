import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createLintServer } from '../src/lint-server';
import { WorktreeLintService } from '../src/lint-service';

type TextBlock = { type: string; text: string };

function textOf(content: unknown): string {
  return (content as TextBlock[])[0]?.text ?? '';
}

/**
 * Real Biome CLI runs against real temp worktrees (R11: biome is a real
 * dependency — `node <biome bin> lint --reporter=json` child processes, no
 * test doubles). The default binary resolver walks up to the pnpm-provided
 * node_modules symlink, mirroring how the composition root will resolve it.
 */
describe('WorktreeLintService (real biome, real worktree)', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).length = 0;
  });

  function makeWorktree(): string {
    const root = mkdtempSync(join(tmpdir(), 'agora-lint-'));
    roots.push(root);
    return root;
  }

  it('returns [] for clean files', async () => {
    const root = makeWorktree();
    writeFileSync(join(root, 'clean.js'), 'export function add(a, b) {\n\treturn a + b;\n}\n');
    const registry = new WorktreeRegistry();
    registry.register(root);
    const service = new WorktreeLintService(registry);
    const issues = await service.check(root, ['clean.js']);
    expect(issues).toEqual([]);
  });

  it('surfaces a structured issue for a lint rule violation', async () => {
    const root = makeWorktree();
    // `a == 2` trips lint/suspicious/noDoubleEquals on biome's second line.
    writeFileSync(join(root, 'linterr.js'), 'const a = 1;\nif (a == 2) { console.log(a); }\n');
    const registry = new WorktreeRegistry();
    registry.register(root);
    const service = new WorktreeLintService(registry);
    const issues = await service.check(root, ['linterr.js']);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const doubleEquals = issues.find((issue) => issue.rule === 'lint/suspicious/noDoubleEquals');
    expect(doubleEquals).toBeDefined();
    expect(doubleEquals?.file).toBe('linterr.js');
    expect(doubleEquals?.line).toBe(2);
    expect(doubleEquals?.message).toContain('==');
    expect(doubleEquals?.severity).toBe('error');
  });

  it('defaults to the whole worktree when paths are omitted', async () => {
    const root = makeWorktree();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'deep.js'), 'const a = 1;\nif (a == 2) { a; }\n');
    const registry = new WorktreeRegistry();
    registry.register(root);
    const service = new WorktreeLintService(registry);
    const issues = await service.check(root, []);
    expect(issues.some((issue) => issue.file.endsWith('deep.js'))).toBe(true);
  });

  it('rejects unregistered roots and retargeted roots', async () => {
    const service = new WorktreeLintService(new WorktreeRegistry());
    await expect(service.check('/tmp/agora-not-registered', [])).rejects.toThrow(/not registered/);
  });

  it.each(['../escape.js', '-flag', '/abs/path.js', 'nested/../escape.js', ''])(
    'rejects path argument %j (R7 confinement)',
    async (badPath) => {
      const root = makeWorktree();
      const registry = new WorktreeRegistry();
      registry.register(root);
      const service = new WorktreeLintService(registry);
      await expect(service.check(root, [badPath])).rejects.toThrow(/lint path/);
    },
  );

  it('throws loudly when the biome binary is unusable (§12: no silent degradation)', async () => {
    const root = makeWorktree();
    const registry = new WorktreeRegistry();
    registry.register(root);
    const service = new WorktreeLintService(registry, { biomeBin: '/nonexistent/biome.js' });
    await expect(service.check(root, [])).rejects.toThrow();
  });
});

/**
 * Round-trip the lint-server over the SDK's real in-memory transport (G5: the
 * `check` tool spawns a real biome child process and returns the issues array
 * through the MCP boundary).
 */
describe('lint-server MCP round-trip', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('serves check over an in-memory transport with a clean result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agora-lint-server-'));
    writeFileSync(join(root, 'clean.js'), 'export const one = 1;\n');
    const registry = new WorktreeRegistry();
    registry.register(root);
    const server = createLintServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lint-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'check',
      arguments: { worktree: root, paths: ['clean.js'] },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res.content))).toEqual([]);
  });

  it('returns isError for an unregistered worktree', async () => {
    const server = createLintServer({ registry: new WorktreeRegistry() });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lint-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'check',
      arguments: { worktree: '/tmp/not-registered' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain('not registered');
  });
});
