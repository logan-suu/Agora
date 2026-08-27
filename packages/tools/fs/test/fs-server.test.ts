import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createFsServer } from '../src/fs-server';
import { WorktreeRegistry } from '../src/worktree-registry';

type TextBlock = { type: string; text: string };

function textOf(content: unknown): string {
  return (content as TextBlock[])[0]?.text ?? '';
}

/**
 * Round-trip the fs-server over the SDK's real in-memory transport (G5: real
 * execution, not a test double). No mocks; the registry and real filesystem are
 * exercised end to end through the MCP client-server boundary.
 */
describe('fs-server MCP round-trip', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('serves read/write/list over an in-memory transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agora-fs-server-'));
    const registry = new WorktreeRegistry();
    registry.register(root);
    const server = createFsServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fs-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const write = await client.callTool({
      name: 'write',
      arguments: { worktree: root, path: 'src/main.ts', content: 'export const x = 1;' },
    });
    expect(textOf(write.content)).toBe('{"ok":true,"path":"src/main.ts"}');

    const read = await client.callTool({
      name: 'read',
      arguments: { worktree: root, path: 'src/main.ts' },
    });
    expect(textOf(read.content)).toBe('export const x = 1;');

    const list = await client.callTool({
      name: 'list',
      arguments: { worktree: root, glob: '**/*.ts' },
    });
    expect(textOf(list.content)).toContain('src/main.ts');
  });

  it('returns isError for a path escaping the worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agora-fs-server-'));
    const registry = new WorktreeRegistry();
    registry.register(root);
    const server = createFsServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fs-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'read',
      arguments: { worktree: root, path: '../../etc/passwd' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain('escapes worktree root');
  });
});
