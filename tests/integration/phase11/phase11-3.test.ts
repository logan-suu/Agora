import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPreviewServer } from '../../../apps/desktop/src/preview-server';
import { acquireState, initializeFormat } from '../../../apps/desktop/src/storage';
import { controlPath } from '../../../apps/web/scripts/local-process.mjs';

it('composes canonical local ownership with authenticated preview HTTP/SSE and durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agora113-integration-'));
  const owner = await acquireState(root);
  const control = createServer((socket) => socket.destroy());
  const preview = createPreviewServer(
    'b'.repeat(64),
    () => ({ credentials: 'locked' }),
    async (_request, response) => {
      response.end();
    },
  );
  try {
    control.listen(controlPath(owner.root));
    await once(control, 'listening');
    await initializeFormat(owner.root);
    await expect(acquireState(root)).rejects.toThrow('state_in_use');
    preview.server.listen(0, '127.0.0.1');
    await once(preview.server, 'listening');
    const headers = { 'x-agora-desktop': 'b'.repeat(64) };
    const response = await fetch(`${preview.origin()}/api/desktop/status`, { headers });
    expect(await response.json()).toEqual({ credentials: 'locked' });
    expect(
      (
        await fetch(`${preview.origin()}/api/tasks`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'start' }),
        })
      ).status,
    ).toBe(403);
    expect(JSON.parse(await readFile(join(owner.root, 'desktop-format.json'), 'utf8'))).toEqual({
      version: 1,
    });
    const stream = await fetch(`${preview.origin()}/api/desktop/events`, { headers });
    const reader = stream.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
      '"credentials":"locked"',
    );
    await reader?.cancel();
  } finally {
    await preview.close();
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve())),
    );
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
});
