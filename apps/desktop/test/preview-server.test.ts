import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPreviewServer } from '../src/preview-server.js';

describe('desktop preview gateway', () => {
  it('authenticates resources and streams and blocks every product API before dispatch', async () => {
    const dispatched: string[] = [];
    const preview = createPreviewServer(
      'a'.repeat(64),
      () => ({ credentials: 'ready' }),
      async (req, res) => {
        dispatched.push(req.url ?? '');
        expect(req.headers['content-security-policy']).toContain("'nonce-");
        res.end('preview');
      },
    );
    preview.server.listen(0, '127.0.0.1');
    await once(preview.server, 'listening');
    const origin = preview.origin();
    const headers = { 'x-agora-desktop': 'a'.repeat(64) };
    try {
      expect((await fetch(`${origin}/desktop`)).status).toBe(403);
      const page = await fetch(`${origin}/desktop`, { headers });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).not.toContain('unsafe-eval');
      for (const path of [
        '/api/tasks',
        '/api/messages',
        '/api/model-settings',
        '/api/traces',
        '/api/commands',
        '/api/stream',
        '/',
      ]) {
        for (const method of ['GET', 'POST'])
          expect((await fetch(origin + path, { headers, method })).status).toBe(403);
      }
      expect(dispatched).toEqual(['/desktop']);
      const stream = await fetch(`${origin}/api/desktop/events`, { headers });
      const reader = stream.body?.getReader();
      const event = await reader?.read();
      expect(new TextDecoder().decode(event?.value)).toContain('event: status');
      await reader?.cancel();
      expect(
        (await fetch(`${origin}/desktop`, { headers: { ...headers, origin: 'https://evil.test' } }))
          .status,
      ).toBe(403);
    } finally {
      await preview.close();
    }
  });
});
