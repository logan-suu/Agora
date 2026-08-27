import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry } from '@agora/tools-fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../src/test-server';

type TextBlock = { type: string; text: string };

function textOf(content: unknown): string {
  return (content as TextBlock[])[0]?.text ?? '';
}

/**
 * Round-trip the test-server over the SDK's real in-memory transport (G5: real
 * execution, not a test double). The `run` tool spawns a real `node --test`
 * child process and returns structured results through the MCP boundary.
 */
describe('test-server MCP round-trip', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('serves run over an in-memory transport with a passing result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agora-test-server-'));
    writeFileSync(join(root, 'ok.test.mjs'), "import test from 'node:test';test('y',()=>{});\n");
    const registry = new WorktreeRegistry();
    registry.register(root);
    const server = createTestServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'run',
      arguments: { worktree: root, cmd: 'node --test ok.test.mjs' },
    });
    expect(res.isError).toBeFalsy();
    const result = JSON.parse(textOf(res.content));
    expect(result.passed).toBe(true);
    expect(result.total).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('returns isError for an unregistered worktree', async () => {
    const registry = new WorktreeRegistry();
    const server = createTestServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'run',
      arguments: { worktree: '/tmp/not-registered', cmd: 'node --test' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content)).toContain('not registered');
  });

  it('honors an explicit timeout argument for a slow command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agora-test-server-'));
    const registry = new WorktreeRegistry();
    registry.register(root);
    const server = createTestServer({ registry });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'run',
      arguments: { worktree: root, cmd: 'node -e "setTimeout(()=>{},100000)"', timeout: 50 },
    });
    const result = JSON.parse(textOf(res.content));
    expect(result.passed).toBe(false);
    expect(result.failures[0].test).toBe('(timeout)');
  });
});
